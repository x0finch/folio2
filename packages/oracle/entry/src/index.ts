// @folio/oracle —— 参考层的服务层与对外门面(#176 / ADR 0021 / 0022 / 0023)。
//
// 设计要点:
//   · 代币表**每个用户一份**,`tokens.id` 是系统内部唯一身份,`tokenRef` 退回两个边界
//   · 认币从**读时**挪到**写时**,结果冻进快照
//   · **这个包不知道上游是谁** —— store 与 upstream 都是 app 在装配时注入的 Layer,
//     dependencies 里只有契约包与文法包,没有任何 client / upstream 包
//   · 五个服务全是 Effect 服务(`Context.GenericTag` + Layer,#362 第 4 站);时间走 `Clock`,
//     降级走 `catchAll(UpstreamError)` 并记一行,配置回调一个不剩
//
// 三包一族:`@folio/oracle-basic`(契约,含 `./ports` 那个只有服务端会碰的 Tag 入口)/
// `@folio/oracle`(本包,服务)/ `@folio/oracle-upstream-coingecko`(上游 adapter)。
//
// **这里只导出「包外真的有人用」的东西。** 内部件(缓存键、SWR 组合子、warm blob 的三个读者、
// 消歧、降级)不外露 —— 它们的测试直接 import `../src/<file>`。
//
// 每个服务名同时是**类型**和**Tag**(`Context.GenericTag`,与 `@effect/platform` 的
// `FileSystem` / `HttpClient` 同款),所以一行 `export { TokenReader }` 两个含义都带出去。

// 契约与数据经门面透出,调用方一个 import 面(同现有做法)。**只透 `.` 那一半** ——
// `./ports` 的 Tag 是运行时值,由装配点自己去那个入口取,不从这里漏进客户端 bundle。
export * from "@folio/oracle-basic";
export { DefiLogoResolver } from "./defi-logos";
export { FxRateResolver } from "./fx";
export { type MintInput, TokenMinter } from "./mint";
export {
  type OraclePorts,
  type OracleServices,
  oracleLayer,
  RefIndexWarmer,
  refIndexWarmerLayer,
} from "./oracle";
export { PlatformResolver } from "./platforms";
export { TokenReader } from "./tokens";
