import { isNotFound, isRedirect } from "@tanstack/react-router";

// 各域 queryOptions 的 `staleTime` 分档。
//
// **绝不设成 QueryClient 的全局默认**(ADR 0038)。「多久算旧」是**每份数据自己的性质** ——
// 余额几十秒就变,连接器清单几乎不变。一个全局数字会被默默套到每一条将来新增的查询上,
// 而写它的人根本不会想起有这么一个默认值存在。
//
// 注:这里**不影响定向刷新的正确性** —— `invalidateQueries` 会把查询标记为 invalid,
// 挂载中的观察者无视 staleTime 立刻重拉。staleTime 只决定「没人主动刷时,重新挂载要不要再拉一遍」。
//
// 分档按「这份数据多久会自己变」来定,不按页面。新域迁进来时往这里加一档,别就地写数字。
export const STALE_TIME = {
  // 余额、同步状态一类:一轮同步会改它,但不会在几十秒内自己变。
  // 够覆盖「首页 ⇄ 账户页来回切」和 hover 预热,又短到用户回头看时不至于是旧的。
  live: 30_000,
  // 上游搜索结果:同一个词在一分钟内不会有新答案,而用户改词就是换 key、本来就重拉。
  search: 60_000,
  // 价值历史曲线(账户 / 单个持仓):按天聚合,只有最右边那个点会随同步动,左边全是冻住的过去。
  // 比 `live` 长一档就是这个道理 —— 曲线的形状不会在半分钟里变得不一样。
  history: 60_000,
  // 用户设置与偏好(估值口径、展示币种、界面语言、数据统计):**只由本人显式改**,
  // 改了就有定向刷新兜着 —— 这个数字只决定「没人改的时候多久重问一次」。
  settings: 5 * 60_000,
  // 代币目录、法币清单、凭据字段规格:跟着部署走,一天里基本不动。
  catalogue: 60 * 60_000,
  // 连接器清单:**部署内静态**,同一个进程里问第二次没有意义。
  deployment: Number.POSITIVE_INFINITY,
} as const;

/**
 * 轮询间隔。**只在「有东西正在变」时才开**(react-query 的 `refetchInterval` 支持按当前数据决定)。
 *
 * 目前只有一处:一轮同步进行中时盯着它的进度(ADR 0048 —— 进度是服务端事实,前端读它)。
 * 1.5s 是照「一轮几十秒、十几发单键读」定的:再快只是多打库,再慢用户会觉得卡住了。
 */
export const POLL_INTERVAL = {
  syncRound: 1_500,
  /**
   * 预计算的结果还在后台重算(响应带 `pending`)时,第一次隔多久再问 —— 之后按
   * `precomputePollDelay` 翻倍。总览、tab 条、两级 24h 盈亏都走这一条。
   *
   * 这些数不在读请求里算(ADR 0049:免费档 10ms CPU),而是同步收官时预计算、缺了由
   * `waitUntil` 补 —— 补算是几百毫秒的事,可 `STALE_TIME.live` 是 30 秒:不问的话,数据
   * 早就在库里了,屏幕上还空着大半分钟。**只在 `pending` 时开**,算好了就一发都不再打。
   * 比同步轮那条略快:补算比一轮同步短得多,而这一条盯的就是「它落地没有」。
   */
  precompute: 1_000,
} as const;

/** `pending` 轮询最多问这么多次就收手(见 `precomputePollDelay`)。 */
const PRECOMPUTE_POLL_ATTEMPTS = 8;

/**
 * 「还一次都没算过」的那一下,取数那层最多把交卷推迟几次(见 `awaitFirstCompute`)。
 *
 * 四次按 `precomputePollDelay` 退避 = 1+2+4+8 秒:补算正常是几百毫秒,第一次等就够了;
 * 15 秒还没落地只说明它这次落不了,那时候把空态交出去、让轮询在后台接着盯,好过让页面
 * 无限挂在骨架上。**这个上限不能去掉** —— 一份永远算不出来的数据配上无限等待就是一张死页面。
 */
const FIRST_COMPUTE_WAITS = 4;

/**
 * 第 n 次收到 `pending` 之后,隔多久再问一次 —— **有退避,而且会放弃**。
 *
 * 定这两条不是保守,是因为不定的话它是台永动机:补算失败(数据本身让计算抛)时键永远填不上 →
 * 响应恒 `pending` → 每秒一发,而**每一发都在服务端排一趟全量重算**。一个用户开着页面就能
 * 把一个 isolate 占满,而屏幕上什么都不会发生。服务端那头也有自己的闸(`backfillForUser`
 * 的连败退避 + 认输),两边各拦一次 —— 前端这条拦的是「一直问」,服务端那条拦的是「一直算」。
 *
 * 1s → 2s → 4s → 8s,15s 封顶(同 `RETRY.delay` 的形状),八次之后不再问:正常情况下补算
 * 几百毫秒就落地,第一发就拿到了;走到第八发只说明它不会好了,那时继续问没有意义。
 * 放弃之后界面停在手头那份(旧值或空态)—— 服务端已经记了 warning,那才是该看的地方。
 */
export function precomputePollDelay(pollCount: number): number | false {
  return pollCount >= PRECOMPUTE_POLL_ATTEMPTS ? false : backoffMs(pollCount);
}

/**
 * 退避的档位本身。**单独抽出来,是为了让「等一等」那两处不必去处理 `false`** ——
 * 它们的次数上限比 `PRECOMPUTE_POLL_ATTEMPTS` 小,那个分支永远走不到,写一个 `if` 在那儿
 * 只会看着像有用。1s → 2s → 4s → 8s,15s 封顶(同 `RETRY.delay` 的形状)。
 */
const backoffMs = (n: number) => Math.min(POLL_INTERVAL.precompute * 2 ** n, 15_000);

/**
 * **这一轮 `pending` 已经问了几次** —— 记在一张 `WeakMap` 上,键是 query 实例本身。
 *
 * 曾经这里写的是 `query.state.dataUpdateCount - 1`,而那是个 bug,还是这一片最要命的那种:
 * `dataUpdateCount` 是这条查询**一辈子**的成功计数(query-core `query.js`,只增不减)——
 * 窗口重新聚焦一次 +1、每次同步失效重拉 +1、每次切组合回来 +1。页面开着不动,九次成功之后
 * 这个表达式就 ≥ 上限,`precomputePollDelay` 从此恒回 `false`,**这条查询余生不再轮询**。
 * 症状是:同步跑完,读到旧值 + `pending`,然后再也没有第二次刷新 —— 「刚同步完,数字没动」,
 * 正是水位线那套机制存在的理由。计数必须按「这一轮 pending」算,不按查询的一辈子算。
 *
 * `pending` 一消失就把记录抹掉,下一轮从头数;`WeakMap` 让查询被移出缓存时记录跟着回收。
 */
const pollEpisodes = new WeakMap<object, number>();

export function pendingPollDelay(query: {
  state: { data?: { pending?: true }; dataUpdateCount: number };
}): number | false {
  if (!query.state.data?.pending) {
    pollEpisodes.delete(query);
    return false;
  }
  const startedAt = pollEpisodes.get(query);
  if (startedAt === undefined) {
    pollEpisodes.set(query, query.state.dataUpdateCount);
    return precomputePollDelay(0);
  }
  return precomputePollDelay(query.state.dataUpdateCount - startedAt);
}

/**
 * **手上连旧值都没有的那一下,先在取数里等一等再交卷**(FOL-36)。
 *
 * 总览与 tab 条也改成读预计算之后,「还没算过」的响应是一份**空的**总览 / 空的 tab 条 +
 * `pending`。而空总览与「这个组合真的一分钱都没有」在屏幕上长得一模一样:总额 0、持仓一条
 * 没有、tab 条那句「还没有账户,去添加一个」。**把「还不知道」画成一个具体的数字,比慢一点
 * 糟得多** —— 24h 盈亏没有这个问题(它的空态是 `—`,本来就念作「不知道」),总览有。
 *
 * 所以这一下不交白卷:后台补算是几百毫秒的事,等它。等待期间组件停在**它自己的骨架**上
 * (这几条读取都在 `QueryBoundary` 里挂起),不必给七个消费点各写一遍「没就绪长什么样」。
 *
 * **有旧值就立刻交卷**(`isEmpty` 为假):那是 ADR 0049 收下的代价 —— 数字可能是几分钟前的,
 * 但它是真的,`refetchInterval` 那条会把新的换上来。
 *
 * **等有上限**,而且退避:补算真算不出来的时候(键永远填不上),不能把页面永远挂在骨架上。
 * 用完次数就照常交出空态,`pending` 的短轮询继续在后台盯着,落地了自己就换上。
 *
 * **必须接 `signal`**:react-query 在查询被取消(切组合、离开页面)时 abort 它 —— 不接的话
 * 每次取消都留下一条循环在后台继续打服务器,与 `constants.ts` 里 `withRetry` 那条同一个教训。
 */
export const awaitFirstCompute = async <A extends { pending?: true }>(
  fetch: () => Promise<A>,
  isEmpty: (a: A) => boolean,
  signal: AbortSignal,
): Promise<A> => {
  let out = await fetch();
  for (let n = 0; n < FIRST_COMPUTE_WAITS && out.pending && isEmpty(out); n++) {
    await sleep(backoffMs(n), signal);
    out = await fetch();
  }
  // **等不到就报错,不能把空态当答案交出去。**
  //
  // 服务端算不出来的时候(预计算连着失败、批量写超限)端出来的就是这份空态,而它与「这个组合
  // 真的一分钱都没有」在线上是同一个值:总额 0、持仓零行。首页把那个 0 喂给曲线的当下点,而曲线
  // **不是**预计算的、是真数据 —— 屏幕上就是一条真实资产曲线在「现在」直坠到零,旁边配一句
  // 「还没有账户,去添加一个」。那是这一片最坏的一种输出:错得像真的。
  //
  // 这一片之前,算不出来是一次查询失败,`QueryBoundary` 画「加载失败」。这里把那条路还回去。
  // 真·空组合走不到这儿:它的预计算会成功,`pending` 随之消失,空态照常端出去。
  if (out.pending && isEmpty(out)) {
    throw new Error("precompute not ready");
  }
  return out;
};

/**
 * **等到重取的结果满足条件为止**(有退避、有上限,退避档位与轮询同一套)。
 *
 * 用在「写完之后界面要跟着变」的那几处:写路径只抬水位线,重算在 `waitUntil` 上,所以紧跟着
 * 的那次刷新拿回的往往还是**改动之前**那份。不等的话,新钉的 Tab 选不中、刚改的指向还显示
 * 老名字 —— 用户看到的是「点了没反应」。
 *
 * 等不到也照常返回手上那份:调用方据此继续(URL 仍是权威,轮询落地后界面自己会对齐)。
 */
export const refetchUntil = async <A>(
  refetch: () => Promise<A>,
  ok: (a: A) => boolean,
): Promise<A> => {
  let out = await refetch();
  for (let n = 0; n < FIRST_COMPUTE_WAITS && !ok(out); n++) {
    await sleep(backoffMs(n));
    out = await refetch();
  }
  return out;
};

/** 可取消的等待。**先看 signal 再挂钩子**,并且两条路都把钩子摘掉 —— 见 `awaitFirstCompute`。 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    // 取消发生在上一发请求飞行期间时,`addEventListener` 已经晚了(abort 事件早就过去了)——
    // 不先问一句,这一觉照睡,醒来再打一次服务器,正是「取消之后还在后台打服务器」那条。
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * 失败重试。**必须显式设**:`ensureQueryData` / `prefetchQuery` 走的是 `fetchQuery`,
 * 而它在 `retry` 没定义时会就地写死 `retry = false`(query-core `queryClient.js`:
 * `if (defaultedOptions.retry === void 0) defaultedOptions.retry = false`)。页面数据全部由
 * loader 预取,所以「不设默认」= 一次失败就是终局 —— 实测掐掉八个接口,20 秒内一次重试都没有。
 * 在 QueryClient 上设了默认,这个值就不是 undefined 了,那行兜底不再生效,loader 那条路一起吃到。
 *
 * 退避到 15 秒封顶、五次为止:约半分钟的争取窗口,足够跨过一次上游抖动或 CPU 超限,
 * 又不至于把一个真坏了的接口打到天荒地老 —— 之后的「持续重试」交给 QueryBoundary 的自愈计时器。
 */
export const RETRY = {
  attempts: 5,
  /** 外壳赖以存在的那几份数据没有「放弃」这个选项 —— 详见下面 `shouldRetry` 的说明。 */
  forever: Number.POSITIVE_INFINITY,
  delay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 15_000),
  /** 边界塌了之后隔多久自己再试一次(连败时逐次翻倍)。 */
  selfHeal: 15_000,
  /** 自愈间隔的上限 —— 一直好不了的那种不该无限频繁地闪。 */
  selfHealMax: 60_000,
} as const;

/**
 * 该不该再试一次。三个否决项:
 *
 * · **服务端一次都不试**。query-core 的默认本来是 `isServer() ? 0 : 3`(retryer.js),显式设了
 *   函数就把这层保护一并盖掉了 —— 而服务端那趟跑在 CF Worker 里,一次请求只有 10 毫秒 CPU
 *   预算(ADR 0049),把它拖上半分钟只会让本来就紧的那条路更难受。浏览器里才有重试的余地。
 * · **跳转**(会话过期要去登录页)与 **404**:再试一百次结果也一样,它们是控制流不是故障。
 * · 其余一律再试。server fn 的失败到了这里是一个没有状态码的通用 Error(框架抛的
 *   `Invariant failed`),分不出 500 还是 400 —— 分不出就都试,代价是 4xx 会白试几次。
 *
 * `attempts` 传 `RETRY.forever` 的地方(外壳那几份数据、鉴权)是有意的:**它们没有降级形态**,
 * 拿不到就没有外壳可画,放弃等于把用户扔在一张死页面上。一直停在骨架上每 15 秒试一次要好得多。
 */
export function shouldRetry(
  failureCount: number,
  error: unknown,
  attempts: number = RETRY.attempts,
) {
  if (typeof window === "undefined") return false;
  if (isRedirect(error) || isNotFound(error)) return false;
  return failureCount < attempts;
}

/**
 * 给**不走 react-query 的**调用用的同款重试(目前只有一处:受保护布局里那次鉴权)。
 * 路由的 `beforeLoad` 里那次 `getSession()` 是裸的 server fn 调用 —— 没有查询缓存包着,
 * 上面那份默认值管不到它,而它恰恰是最不能失败的一个:它一挂,整棵登录后的树连外壳都画不出来。
 * 跳转(会话过期)必须原样抛出去,不能当失败重试。
 *
 * 鉴权那处传 `RETRY.forever`:**它没有「放弃」这个选项**。放弃了这条 match 就变成 error 态,
 * 而 error 态**自己好不了** —— errorComponent 收到的 `reset` 只是清掉边界自己的 state
 * (react-router `CatchBoundary.reset`),清完重渲染时 `match.status` 仍是 `"error"`,
 * `Match.js` 当场把同一个错误再抛一遍,loader 一次都不会重跑。也就是说落进去就只能靠用户刷新。
 * 停在骨架上一直试要好得多 —— 服务器缓过来的那一轮页面自己就长出来了。
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  isControlFlow: (e: unknown) => boolean,
  attempts: number = RETRY.attempts,
  signal?: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    // 这条循环可以是无限的,所以**必须有取消通道**:路由把导航取消(用户点了别处、
    // hover 预取被丢弃)时会 abort 这个 signal,不接的话每次取消都留下一条循环在后台
    // 每 15 秒打一次服务器,直到标签页关掉。
    signal?.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      if (isControlFlow(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY.delay(attempt)));
    }
  }
}
