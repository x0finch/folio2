import type {
  CacheStore,
  FxUpstream,
  GlobalTokenRefIndexStore,
  Namer,
  PlatformUpstream,
  TokenPriceStore,
  TokenStore,
  TokenUpstream,
} from "@folio/oracle-basic/ports";
import { Layer } from "effect";
import { candidateSourceLayer } from "./services/candidates";
import { type FxRateResolver, fxRateResolverLayer } from "./services/fx";
import { type FxHistory, fxHistoryLayer } from "./services/fx-history";
import { type TokenMinter, tokenMinterLayer } from "./services/mint";
import { type PlatformResolver, platformResolverLayer } from "./services/platforms";
import { type TokenReader, tokenReaderLayer } from "./services/tokens";

// 装配。**`createOracleFor(cfg)` 没了** —— 那个 config 对象上挂着 7 个 `createXxx(userId)` 工厂
// 回调,正是 CODING.md 反复改掉的那个模式:能替换的东西该是**服务**(Layer),不是配置字段。
// 换掉它同时解决了三件事:
//   · 惰性(以前用 getter + `??=` 手写)由 Layer memoisation 免费给,而且**成本本来就没那么大** ——
//     `packages/db/src/client.ts` 自己写着「drizzle(env.DB) 很轻,每次创建即可」,四个 store 全建
//     是常数级开销;当初那句「一拼 config 就把所有 store new 出来」担心的是不存在的代价
//   · `namer` / `overrides` 不再由装配点从 adapter 搬到服务层 —— adapter 的 layer 直接给 `Namer`
//   · `now?: () => number` 五个字段全删,时间走 `Clock`(测试 `TestClock`)
//
// **userId 仍然在类型上防错**:per-user 的三个 store layer 由 app 侧按 userId 现建
// (`oracleLayerFor(userId)`),服务层的方法签名里一个 user 参数都没有 —— 拿错用户在编译期
// 就发生不了,而这一层压根不知道有 userId 这回事。
//
// 一个用户的参考层由五个服务组成,按**领域**分(ADR 0012 的口径),不按能力切碎:
//   · `TokenReader`       读路径 —— 富化 / 现价 / 历史价 / 橱窗 / 搜索
//   · `TokenMinter`       写路径 —— tokenRef → token_id,写快照之前必须先过这一步
//   · `FxRateResolver`    展示币种**现**汇率 —— 与代币无关的一小块,只共用同一张 per-user 缓存
//   · `FxHistory`         法币的**历史**日汇率 —— BTC 反算,落 `token_daily_prices`,不碰 user_cache
//   · `PlatformResolver`  链 ∪ 场馆的名与图
//
// **`RefIndexWarmer` 不在这五个里**(`./services/ref-index`):刷全局映射表跟 userId 无关,
// cron 单独 provide 它。它以前就写在本文件里 —— 于是这个「装配点」看着装五个、实际生了第六个。
//
// **`DefiLogoResolver` 不在这儿了**(移回 app):DeFi 协议图来自用户自己同步下来的余额 meta,
// 没有上游、不出网 —— 它的 `R` 里一个上游都没有,那本身就是「它不属于参考层」的类型级写法。
// 现在它是 app 的 `defi-logo-store.ts`,同样落 `defi-logo:<协议>` 那个键。
//
// 「info 数据 vs 价格数据」的分离落在**端口**上(`TokenStore` / `TokenPriceStore`),
// 不在服务上再切一遍(ADR 0023)。
export type OracleServices =
  | TokenReader
  | TokenMinter
  | FxRateResolver
  | FxHistory
  | PlatformResolver;

// 五个服务要的全部端口。app 侧提供这些,就拿到整个参考层。
export type OraclePorts =
  | TokenStore
  | TokenPriceStore
  | CacheStore
  | GlobalTokenRefIndexStore
  | TokenUpstream
  | FxUpstream
  | PlatformUpstream
  | Namer;

// `CandidateSource` 在这里被吃掉 —— 它是 mint 的内部依赖(#216 把它从 `TokenReader` 上摘下来的
// 那个),不该出现在装配点的 `R` 里。
export const oracleLayer: Layer.Layer<OracleServices, never, OraclePorts> = Layer.mergeAll(
  tokenReaderLayer,
  Layer.provide(tokenMinterLayer, candidateSourceLayer),
  fxRateResolverLayer,
  fxHistoryLayer,
  platformResolverLayer,
);
