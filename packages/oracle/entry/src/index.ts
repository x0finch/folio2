// @folio/oracle —— 参考层的服务层与对外门面(#176 / ADR 0021 / 0022 / 0023)。
//
// 设计要点:
//   · 代币表**每个用户一份**,`tokens.id` 是系统内部唯一身份,`tokenRef` 退回两个边界
//   · 认币从**读时**挪到**写时**,结果冻进快照
//   · **这个包不知道上游是谁** —— store 与 upstream 都是 app 在装配时注入的 Layer,
//     dependencies 里只有契约包与文法包,没有任何 client / upstream 包
//   · 服务全是 Effect 服务(`Context.GenericTag` + Layer,#362 第 4 站);时间走 `Clock`,
//     降级走 `catchAll(UpstreamError)` 并记一行,配置回调一个不剩
//
// 三包一族:`@folio/oracle-basic`(契约,含 `./ports` 那个只有服务端会碰的 Tag 入口)/
// `@folio/oracle`(本包,服务)/ `@folio/oracle-upstream-coingecko`(上游 adapter)。
//
// **对外三个 per-user 服务** + 一个全局维护门面:
//   `TokenService` 代币 · `FxService` 汇率 · `PlatformService` 平台
//   `GlobalRefIndexService` 刷全局映射表(cron;不进 `oracleLayer`)
//
// **src 的编排判据:一个领域一个位置,没有分类目录。**
//
//   `tokens/`           代币 —— 它自己就是一个文件夹(十二个方法、五片实现 + 它专属的内部件),
//                       从 `./tokens` 这个 index 出口对外;那个文件的开头有它内部的分片图
//   `fx.ts`             汇率
//   `platforms.ts`      平台
//   `oracle.ts`         per-user 装配(三个服务拼成 `oracleLayer`)
//   `global-ref-index.ts` 刷全局映射表的 cron 门面(`GlobalRefIndexService`,不进 `oracleLayer`)
//   `index.ts`          本文件,唯一的对外出口
//
// **那个 `global-` 前缀是这一层唯一的分界,而且它划的不是「模块」而是「谁的」。**
// 上面三个领域全是 per-user 的(它们的端口要 userId 才建得出来);`global-ref-index` 那张表
// 里一条用户数据都没有(ADR 0022),cron 没有用户也能跑它。它维护的映射恰恰是 `tokens/mint.ts`
// 在读的,所以按「领域」分它该进 `tokens/` —— 但进去就意味着它得挂在 per-user 的 `TokenService` 上,
// 于是 cron 只能编一个假 userId。**「没有 userId 就构造不出 per-user 的东西」是原则 #6 的实现方式,
// 不能为了目录好看去破它**,所以这一件按「谁的」而不是按领域摆,文件名把理由写在脸上。
//
// **没有 `services/`,也没有 `internal/`。** 前者是废话(这一层除了服务没有别的);后者曾经装着
// 六件共用件,但真正三家共用的只有降级与 SWR 两个组合子,其余四件只有代币用得上 —— 一个只为
// 「不外露」而存在的目录,读的人会误以为里面的东西谁都在用。现在**每一件都住在用它的那个领域里**,
// 而「外不外露」由这个出口说了算:没写在下面的,包外就拿不到。
//
// 代价说清楚:SWR + 降级(`tokens/swr`)领域中立,却住在 `tokens/` 里,于是 `fx.ts` /
// `platforms.ts` 要 `import from "./tokens/swr"`。哪天第四个领域也要 SWR,该提回一个共用位置。
//
// 每个服务名同时是**类型**、**Tag** 和**它自己的 layer**(`Effect.Service`:`.Default` 就是
// layer),所以一行 `export { TokenService }` 三个含义都带出去 —— 不再有并排的 `xxxServiceLayer`。
//
// **本包整个只有服务端会碰,所以它不转发 `@folio/oracle-basic`。**
//
// 以前这里有一句 `export * from "@folio/oracle-basic"`,图的是「调用方一个 import 面」。
// 代价是这个入口同时供着**契约**(客户端组件真的要 `tokenTicket` / `valuate` /
// `SUPPORTED_CURRENCIES`)和几个 Tag(`Context.GenericTag(...)`,运行时值)——
// 一个组件为了拿契约 import 了本包,`effect` 就跟进客户端 bundle(+75 KB gzip)。
// 今天没进,只是碰巧没人这么写;`@folio/oracle-basic` 为同一个理由早就把 Tag 拆去了 `./ports`。
// 去掉这句之后,客户端要契约只有一条路(`@folio/oracle-basic`),而那条路上没有 `effect`。
//
// (下面这串按字母序 —— Biome 排的,别照着它读结构;结构见上面那张图。)

export { FxService } from "./fx";
export { GlobalRefIndexService } from "./global-ref-index";
export { type OraclePorts, type OracleServices, oracleLayer } from "./oracle";
export { PlatformService } from "./platforms";
export { type MintInput, type RefreshStaleReport, TokenService } from "./tokens";
