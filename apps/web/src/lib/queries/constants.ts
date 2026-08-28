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
} as const;

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
  delay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 15_000),
  /** 边界塌了之后每隔多久自己再试一次。 */
  selfHeal: 15_000,
} as const;

/**
 * 给**不走 react-query 的**调用用的同款重试(目前只有一处:受保护布局里那次鉴权)。
 * 路由的 `beforeLoad` 里那次 `getSession()` 是裸的 server fn 调用 —— 没有查询缓存包着,
 * 上面那份默认值管不到它,而它恰恰是最不能失败的一个:它一挂,整棵登录后的树连外壳都画不出来。
 * 跳转(会话过期)必须原样抛出去,不能当失败重试。
 *
 * 鉴权那处传 `Infinity`:**它没有「放弃」这个选项**。放弃了整棵树就只剩框架自带的白底错误页,
 * 而框架在「loader 失败」这条路上不给重试句柄(react-router `Match.js`:那一支的 `reset` 是
 * `undefined`),也就是说一旦落进去就只能靠用户自己刷新。停在骨架上每 15 秒试一次要好得多 ——
 * 服务器缓过来的那一轮页面自己就长出来了。
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  isControlFlow: (e: unknown) => boolean,
  attempts: number = RETRY.attempts,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (isControlFlow(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY.delay(attempt)));
    }
  }
}
