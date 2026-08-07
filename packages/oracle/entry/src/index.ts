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
// **src 的编排就一条判据:有 Tag 的进 `services/`,没 Tag 的进 `internal/`。**
// 顶层只剩这个出口与 `layer.ts`(装配)。`internal/` 那四件(warm blob、消歧、SWR 组合子、
// 降级)包外一个都不导出 —— 它们的测试直接 import `../src/internal/<file>`。
//
// 每个服务名同时是**类型**和**Tag**(`Context.GenericTag`,与 `@effect/platform` 的
// `FileSystem` / `HttpClient` 同款),所以一行 `export { TokenReader }` 两个含义都带出去。

// 契约与数据经门面透出,调用方一个 import 面(同现有做法)。**只透 `.` 那一半** ——
// `./ports` 的 Tag 是运行时值,由装配点自己去那个入口取,不从这里漏进客户端 bundle。
export * from "@folio/oracle-basic";
export { type OraclePorts, type OracleServices, oracleLayer } from "./layer";
export { FxRateResolver } from "./services/fx";
export { FxHistory } from "./services/fx-history";
export { type MintInput, TokenMinter } from "./services/mint";
export { PlatformResolver } from "./services/platforms";
export { RefIndexWarmer, refIndexWarmerLayer } from "./services/ref-index";
export { type RefreshStaleReport, TokenReader } from "./services/tokens";
