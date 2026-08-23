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
// —— **开销** ——
//
// 不加采样、不加开关:span 对象**本来就在建**(no-op tracer 也建,错误堆栈要它),这一层多的
// 只是每个 span 一次 `push` 和两个时间戳。一次请求个位数个 span,量级在微秒。
//
// 真正可能贵的是**打**那一下,所以它是 `debug`:默认级别(`info`)下 LogTape 直接丢掉,
// 连字符串都不拼。要看树就把 `LOG_LEVEL` 调成 `debug`(见 entry/log-level.ts)。

const log = getLogger(["folio", "web", "trace"]);

interface Recorded {
  readonly name: string;
  readonly depth: number;
  readonly startNs: bigint;
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
        .map(
          (r) => `${"  ".repeat(r.depth)}${r.name} ${r.endNs ? msOf(r.endNs - r.startNs) : "?"}ms`,
        )
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
      const row: Recorded = { name, depth, startNs: startTime };
      c.rows.push(row);
      const span: Tracer.Span = {
        _tag: "Span",
        spanId: `${c.rows.length}`,
        traceId: "folio",
        name,
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes: new Map(),
        links: [...links],
        sampled: true,
        kind,
        attribute() {},
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
 * `warmAllUsers` 的 `warmOne`、`pruneNotesAllUsers` 的 `pruneOne` 同一个理由。
 */
export const spanTracerTo = (emit: (tree: string) => void): Layer.Layer<never> =>
  Layer.unwrapEffect(Effect.sync(() => Layer.setTracer(tracerOf(makeCollector(emit)))));

export const spanTracer: Layer.Layer<never> = spanTracerTo((tree) =>
  log.debug("span tree\n{tree}", { tree }),
);
