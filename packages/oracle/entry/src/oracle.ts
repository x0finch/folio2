import type { DatabaseForOracle, GlobalDatabase } from "@folio/db";
import type { FxUpstream, Namer, PlatformUpstream, TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect, Layer } from "effect";
import { FxService } from "./fx";
import { PlatformService } from "./platforms";
import { TokenService } from "./tokens";
import { CandidateSource } from "./tokens/candidates";

// 装配。**`createOracleFor(cfg)` 没了** —— 那个 config 对象上挂着 7 个 `createXxx(userId)` 工厂
// 回调,正是 CODING.md 反复改掉的那个模式:能替换的东西该是**服务**(Layer),不是配置字段。
// 换掉它同时解决了三件事:
//   · 惰性(以前用 getter + `??=` 手写)由 Layer memoisation 免费给,而且**成本本来就没那么大** ——
//     `packages/db/src/connect.ts` 自己写着「drizzle(env.DB) 很轻,每次创建即可」,四个 store 全建
//     是常数级开销;当初那句「一拼 config 就把所有 store new 出来」担心的是不存在的代价
//   · `namer` / `overrides` 不再由装配点从 adapter 搬到服务层 —— adapter 的 layer 直接给 `Namer`
//   · `now?: () => number` 五个字段全删,时间走 `Clock`(测试 `TestClock`)
//
// **userId 仍然在类型上防错**:`DatabaseForOracle` 由 app 侧按 userId 现建(装配点 provide 一个
// `CurrentUser`,ADR 0044),服务层的方法签名里一个 user 参数都没有 —— 拿错用户在编译期
// 就发生不了,而这一层压根不知道有 userId 这回事。
//
// 一个用户的参考层由**三个**服务组成,按**领域**分(ADR 0012 的口径),不按能力切碎:
//   · `TokenService`     代币 —— mint(写时定死身份)/ 富化 / 现价 / 历史价 / 橱窗 / 搜索
//   · `FxService`        汇率 —— 展示币种的现汇率 + 法币的历史日汇率
//   · `PlatformService`  平台 —— 链 ∪ 场馆的名与图
//
// **以前是五个**,多出来的那两刀都是按「能力」切的,不是按领域:
//   · `TokenReader` / `TokenMinter` 按读写分 —— 而「读」那半自己就在写(刷价、落历史日价、
//     重写橱窗 blob)。真正的那条线是「身份何时定死」,由 `TokenService.mint` 这个方法表达。
//   · `FxRateResolver` / `FxHistory` 按「现在 / 历史」分 —— 同样的理由对 `TokenService` 的
//     现价与历史价全都成立,而那边从来没人提议拆。
// 判据统一之后服务数从 5 落到 3。**能力没有减少,方法一个没删** —— 只是不再每样能力一个 Tag。
//
// **`GlobalRefIndexService` 不在这里**(`./global-ref-index`):刷全局映射表跟 userId 无关,
// cron 单独 provide 那个 layer + 两个端口就能跑,不必先建 per-user 的三张 store。
//
// **`DefiLogoResolver` 不在这儿了**(移回 app):DeFi 协议图来自用户自己同步下来的余额 meta,
// 没有上游、不出网 —— 它的 `R` 里一个上游都没有,那本身就是「它不属于参考层」的类型级写法。
// 现在它是 app 的 `defi-logo-store.ts`,同样落 `defi-logo:<协议>` 那个键。
//
// 「info 数据 vs 价格数据」的分离落在 db 那几片上(`tokens` / `tokenPrices`),
// 不在服务上再切一遍(ADR 0023)。
/**
 * **对外的那一张门票** —— 一个 `yield* Oracle` 拿到整个参考层,按领域取用:
 * `(yield* Oracle).fx.resolve("EUR")`。与 `@folio/db` 的聚合 `Database` 对称(#504 T15)。
 *
 * 换掉的是「handler 得知道自己要的是哪三张 Tag 里的哪一张」:一段既要现价又要汇率的代码
 * 以前 `yield* TokenService` 一次、`yield* FxService` 一次,而这两句除了取服务什么也没做。
 * 三个域服务本身**一个都没动** —— 这一层只是把它们挂到三个字段上,`tokens.mint` 还是
 * `TokenService.mint` 本尊(单测钉着这条)。
 *
 * 三个域服务随迁移转为包内细节,出口在 #504 T13 收割;`GlobalRefIndexService` 照旧独立
 *(cron 用,没有 userId,不该为它建 per-user 的三张 store)。
 */
export class Oracle extends Effect.Service<Oracle>()("oracle/Oracle", {
  effect: Effect.gen(function* () {
    return {
      tokens: yield* TokenService,
      fx: yield* FxService,
      platforms: yield* PlatformService,
    };
  }),
}) {}

// 聚合也在里面 —— 装配点 provide `oracleLayer` 之后 `yield* Oracle` 直接可用,
// 而三个域服务仍然各自可拿(过渡期还有调用点在用,T7–T12 逐批换掉)。
export type OracleServices = Oracle | TokenService | FxService | PlatformService;

// 三个服务要的全部端口。app 侧提供这些,就拿到整个参考层。**一个端口都没少** ——
// 服务合并动的是 Tag 的数量,不是这一层要什么。
export type OraclePorts =
  // 本地那几片来自 `@folio/db` 的两张门票,**不是端口** —— 契约就是它那几份实现。
  // `DatabaseForOracle` 是代币行 / 价格行 / 缓存(只给参考层,handler 拿不到);
  // `GlobalDatabase` 是 mint 要正查的那张全局映射表(它没有 userId)。
  DatabaseForOracle | GlobalDatabase | TokenUpstream | FxUpstream | PlatformUpstream | Namer;

// `CandidateSource` 在这里被吃掉 —— 它是 mint 的内部依赖(#216 把它从读路径的网络面上摘下来的
// 那个),包内 Tag,不该出现在装配点的 `R` 里。
const domains = Layer.mergeAll(
  Layer.provide(TokenService.Default, CandidateSource.Default),
  FxService.Default,
  PlatformService.Default,
);

// `provideMerge` 而不是 `provide`:聚合要的三个服务喂给它,同时**也留在外面** ——
// 过渡期的调用点还在 `yield* FxService`,而两条路拿到的必须是同一个实例
//(memoisation 的作用域是一次构建,这里就是那一次)。
export const oracleLayer: Layer.Layer<OracleServices, never, OraclePorts> = Layer.provideMerge(
  Oracle.Default,
  domains,
);
