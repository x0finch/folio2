# 采用 Effect 作为异步编排层,自 `@folio/sync` 起逐包迁移

仓里的异步编排能力(退避重试、限频、单次超时、有界并发、逐步骤 best-effort 降级)一直是手搓的 —— `@folio/shared` 的 `retry.ts` / `ratelimit.ts` / `http.ts` 共 334 行,加上 `@folio/sync` 编排器里的 `runPool` / `withTimeout` / `withRetryLogged`。这些代码本身没问题,但**错误全靠鸭子类型判定**(`err.retryable === true`),重试判据与超时包装之间对不对得上没有任何东西在检查,时序测试只能靠注入假 `sleep` 粗测。

**决定:采用 [Effect](https://www.effect.website/)(3.22+)作为异步编排层,从 `@folio/sync` 开始,按收益逐包迁移。**

## 迁移范围与顺序

- **范围**:`packages/*` 全部 + `apps/web` 的**服务端那半**(server fn / cron / 装配层)。
- **顺序**(按 Effect 收益排):`sync` → `connectors` → `shared` → `clients` → `oracle` → `db`。
  - `sync` 打头:全仓唯一把重试 × 超时 × 并发 × 隔离 × 降级五件事叠在一起的地方,收益最大、边界最清楚,能拿到真实手感再推广。
  - `connectors` 次之:错误类型 + HTTP 重试 + 限频 + 并发拉多 Wallet。`ProviderError`(60 个构造点、9 个 provider 包)改成 Effect 的 tagged error 归这一步 —— `sync` 迁移期先在包内搭 30 行临时桥,到这步拆掉。
  - `shared` 特殊:`retry.ts` / `ratelimit.ts` / `http.ts` 会被 Effect 原生能力**替代而非迁移**,那一步是删代码。
  - `db` 收尾:全是简单 D1 调用,Effect 化只是包层壳。
- **收益小的包可以永远不迁。** 为了「一致」去迁 `db` 是为了好看,不是为了好用。这条明确写进来,免得以后有人拿一致性当理由。

## 明确排除:React 前端

`apps/web` 的 React 那半**不迁**。那边已经有 TanStack Query / Router 一整套数据与状态方案,再叠 Effect 的前端集成会正面冲突,而收益远不如服务端侧明确。这是**边界,不是「还没轮到」**。

## Considered Options

- **继续手搓** —— 现有代码能跑、体量也不大(sync 编排器 300 行)。否掉的理由不是它写得差,而是它**没有任何机制保证各部分对得上**:超时被手动包成 `retryable: true` 的 `ProviderError`,和 `isRetryable` 判据是两处独立代码,改一处不会让另一处报错。Effect 把这类不一致变成编译错误(实测:`Effect.timeout` 往错误通道加 `TimeoutException`,只认 provider 错误的重试策略当场类型不匹配)。
- **只在新代码用 Effect,老代码不动** —— 会长期维持两套写法,而两套的边界正好落在最需要看清楚的地方(provider 错误如何流进编排)。要么迁要么不迁。
- **换个更小的库(如 neverthrow / p-retry 组合)** —— 单点能替,但拿不到「重试策略是可组合的值」和 `TestClock` 确定性时序测试这两样,而这两样正是当前最缺的。

## Consequences

- **体积:一次性 +75 KB(gzip),不是每包一份。** 实测 Effect 完整编排(tagged error + Schedule 退避 + 超时 + 有界并发)bundle 后 gzip 75.2 KB,对比现有 `dist/server` 合计 1.3 MB 约 +6%。后续各包迁移的**边际体积成本接近零** —— 这是全仓迁移在体积上站得住的关键,也是「要迁就整个迁」比「只迁一个包」更划算的原因。
  - 例外:`Effect.Schema` 若用来替 zod,净增约 60 KB。**本 ADR 不决定这件事**,留到 `connectors` 迁移时单独评估。
- **迁移期两套重试并存。** `sync` 迁完后它用 Effect 的 `Schedule`,而 `shared/withRetry` 仍在服务 `shared/http.ts`(所有 provider)和加账户探活。这是**过渡态**,到 `shared` 那一步消失。
- **学习成本是真的,而且是每个碰它的人付一次。** 现有 `retry.ts` 是朴素 JS,扫一眼就懂;Effect 版更短但要先懂 `Schedule` 的 `Out`/`In` 两个类型参数、`passthrough` 为什么能换出错误、pipe 顺序为什么影响类型。这是接受的代价,不是被忽略的。
- **不装 `@effect/vitest`。** 它的 stable 版(0.30.0)peer 锁 `vitest ^3.2.0`,本仓在 4.1.9,支持 v4 的只有 `4.0.0-beta.*`。`TestClock` / `TestContext` 都从 `effect` 主入口直接导出,手写 `Effect.provide(TestContext.TestContext)` 即可,零额外依赖。这条对所有包的迁移都适用。
- **日志走 Effect 的日志系统 + 一个转发器接回 LogTape。** Effect 没有「全局替换 logger」这回事,转发器只能在跑 Effect 那一刻挂进去 —— 所以**只有当调用方自己持有 Effect 并 `runPromise` 时才挂得上**。这决定了各包迁移的节奏:包内先 Effect 化、出口暂时套 Promise 壳的阶段,日志维持原样;等边界也推出去了再换日志。LogTape 那套(全局配置、生产输出 JSON Lines 喂 Workers Logs 抽字段、AsyncLocalStorage 带请求上下文)不能丢,直接用 Effect 默认 logger 输 console 会让它全失效。

关联:`packages/sync/src/orchestrator.ts`(第一站)、`packages/shared/src/retry.ts`(最终被替代)、`packages/connectors/basic/src/errors.ts`(`ProviderError`,第二站)。
