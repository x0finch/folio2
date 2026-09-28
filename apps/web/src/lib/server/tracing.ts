import { getLogger } from "@logtape/logtape";
import { Effect, Layer, Option, Tracer } from "effect";

// **一次请求慢在哪一段 —— 一行日志说完。**
//
// `Effect.fn("createTabPin")` 从 T1 起就在建 span 了,只是它们落在一个 no-op tracer 上:
// 错误堆栈那半已经吃到(`Cause.pretty` 里的 `at createTabPin`),而「这一段花了多久」一直没人接。
// 这个文件把它接住(#504 T16)。
//
// —— **选型:自己收,不接 OTLP** ——
//
// `@effect/opentelemetry` + OTLP 导出是标准答案,在 Workers 上也跑得起来
//(`@microlabs/otel-cf-workers` 那条路)。**否决的理由不是技术,是形状**:它要一个 collector
// 端点 + 一组鉴权头,也就是要自托管者先去开一个 Honeycomb / Grafana 账号。folio 是自托管的
// 单人应用,DEPLOY.md 那条默认路子连自定义域名都没有 —— 为了看一棵 span 树而引入一项外部
// 依赖,不划算,而且它给不了「装上就有」。
//
// 这里换来的:**零依赖、零配置、Workers 上就能跑**,而且答的是同一个问题。
// 换不来的:跨请求聚合、百分位、火焰图。真需要那些的那天,再把这个 tracer 换成 OTLP 导出器 ——
// 被测代码一个字都不用改,那正是 `Effect.fn` 已经把名字写在原地的好处。
//
// —— **开销与开关:只在 `LOG_LEVEL` 为 debug 时装** ——
//
// 这一层原先「不加开关」,理由是「一次请求个位数个 span,量级在微秒」。**实测不是这样**
//(生产 bundle 的 V8 profile):一次请求十几到几十个 span(`Database` 聚合出口的 `bindPerCall`
// 一个 op 一个、桥那头一个查询一个),每个一行 + 一个 Map + 一次 depth 登记,根收工时再把整棵树
// 拼成一个字符串 —— 而默认级别(`info`)下 LogTape 收到它就丢,拼了白拼。免费计划一次请求
// 10ms CPU,这笔账付不起。
//
// 所以现在是 **`withSpanTree` 在发动点问一句「这行 debug 会不会真的落地」**:会,才装树;
// 不会,就不装,span 落回 Effect 自带的 native tracer(它只建 span 对象,不收集、不拼串)。
// 判据问的是 LogTape 本身(`isEnabledFor("debug")`),而 LogTape 的门限就是 `entry/log.ts` 从
// `LOG_LEVEL` 解析出来的那一个 —— **不另读一次 env**,两边不可能对不上。
//
// **没有顺手 `Effect.withTracerEnabled(false)`,是实测过的**:
//   · 省不下东西。三个端点 A/B 交替各测两轮,关与不关的 CPU 差在噪声以内。原因是贵的那一下
//     (`withSpan` / `Effect.fn` 每次调用 `new Error()` 抓调用点)**不看开关**,Effect 3.22 的
//     `addSpanStackTrace` 无条件执行;开关只把 native span 换成 no-op span。
//   · 却会弄丢错误里的 handler 名。关掉之后子 span 认不到父(no-op span 带 `DisablePropagation`,
//     父链在那儿断掉),`Cause.pretty` 只剩最里那一层:`at db.query`,没有 `at createTabPin`。
//     `requireAuth` 的兜底日志正是靠那条链认出「哪个 handler」(见 session/require-auth.ts)。
//   抓调用点那笔账在它真没信息的地方直接免掉:`@folio/db` 的 `bindPerCall` 传了
//   `captureStackTrace: false`(七十个 op 的调用点全是同一行)。
//
// 也因此 `flush` 不做惰性拼串:树只在 debug 落地时才存在,它拼出来的字符串一定会被打出去。
// 要看树就把 `LOG_LEVEL` 调成 `debug`(见 entry/log-level.ts)。

// —— **它接不到的那一处** ——
//
// `/api/sync` 的后台任务(`driveRound` 里那句 `runPromise`)**另起一条根 fiber**,而根 fiber
// 不继承外层的 `Effect.provide`(#504 T12 里为日志层实测过同一件事)。所以那一趟同步不出树。
// 没顺手补上是有判据的:一轮几十秒、逐账户落库,「一次请求一棵树」这个形状对它本来就不合适
// —— 真要看它,轮记录本身(ADR 0048)就是它的账本,树该另行设计,不是把这份硬塞进去。
//
// **不影响 `Cause.pretty` 里的 handler 名**(T6 那半):换掉 tracer 之后错误堆栈里的
// `at createTabPin` 照旧(实测过 —— 默认 tracer 与这份并排跑,两边输出逐字相同)。

const log = getLogger(["folio", "web", "trace"]);

interface Recorded {
  readonly name: string;
  readonly depth: number;
  readonly startNs: bigint;
  /** `Effect.annotateSpans` 挂上来的东西(runEffect 挂的是 userId)。只在根那行打。 */
  readonly attributes: Map<string, unknown>;
  endNs?: bigint;
}

const msOf = (ns: bigint): string => (Number(ns) / 1_000_000).toFixed(1);

/**
 * 一棵树的收集器。**一次请求一个** —— 它由 `spanTracer` 这张 layer 现建,请求结束就跟着走,
 * 所以不必操心跨请求的 Map 会不会漏(它压根不存在)。
 */
const makeCollector = (emit: (tree: string) => void) => {
  const rows: Recorded[] = [];
  const depthOf = new WeakMap<object, number>();

  const flush = () => {
    // 根 span 收工 = 这次请求的树完整了。**按开始顺序**打,缩进即父子。
    emit(
      rows
        .map((r) => {
          const took = r.endNs ? msOf(r.endNs - r.startNs) : "?";
          // 注解只在根那行打:`runEffect` 挂的 userId 是整棵树的属性,每行抄一遍是噪音。
          const attrs =
            r.depth === 0 && r.attributes.size > 0
              ? ` ${[...r.attributes].map(([k, v]) => `${k}=${String(v)}`).join(" ")}`
              : "";
          return `${"  ".repeat(r.depth)}${r.name} ${took}ms${attrs}`;
        })
        .join("\n"),
    );
    rows.length = 0;
  };

  return { rows, depthOf, flush };
};

type Collector = ReturnType<typeof makeCollector>;

const tracerOf = (c: Collector): Tracer.Tracer =>
  Tracer.make({
    span(name, parent, context, links, startTime, kind) {
      const depth = Option.match(parent, {
        onNone: () => 0,
        onSome: (p) => (c.depthOf.get(p) ?? 0) + 1,
      });
      const row: Recorded = { name, depth, startNs: startTime, attributes: new Map() };
      c.rows.push(row);
      const span: Tracer.Span = {
        _tag: "Span",
        spanId: `${c.rows.length}`,
        traceId: "folio",
        name,
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes: row.attributes,
        links: [...links],
        sampled: true,
        kind,
        attribute(key, value) {
          row.attributes.set(key, value);
        },
        event() {},
        addLinks() {},
        end(endTime) {
          (row as { endNs?: bigint }).endNs = endTime;
          if (depth === 0) c.flush();
        },
      };
      c.depthOf.set(span, depth);
      return span;
    },
    // 这个 tracer 不做 context 传播(没有跨进程的下一跳),原样跑就行。
    context: (f) => f(),
  });

/**
 * 装上它,`Effect.fn` 的那些名字就有了时长。**每次 provide 现建一个收集器** —— 一次请求一棵树,
 * 互不串,也不必操心跨请求的 Map 会不会漏。
 *
 * `emit` 可注入,只为单测能把树接出来看(生产路径用默认的那个 debug 日志)—— 与
 * `fanOutAllUsers` 的 `fanOutOne`、`consumeMessage` 的 `run` 同一个理由。
 */
export const spanTracerTo = (emit: (tree: string) => void): Layer.Layer<never> =>
  Layer.unwrapEffect(Effect.sync(() => Layer.setTracer(tracerOf(makeCollector(emit)))));

const spanTracer: Layer.Layer<never> = spanTracerTo((tree) =>
  log.debug("span tree\n{tree}", { tree }),
);

/**
 * **发动点用的就是它** —— `runForUser` 与 cron 的 `runAtEdge` 各包一次,别处不装树。
 *
 * `LOG_LEVEL` 为 debug(或 trace)→ 装上面那棵树;否则原样放行(判据与理由见文件头
 * 「开销与开关」)。在**发动那一刻**问 LogTape、不缓存:门限是 `configureLogging` 配好的,
 * 这里只是查一下它已经解析好的那张表。
 */
export const withSpanTree = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  log.isEnabledFor("debug") ? Effect.provide(effect, spanTracer) : effect;
