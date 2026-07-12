import type {
  FxRates,
  FxStore,
  PlatformStore,
  Platforms,
  TokenProvider,
  TokenRef,
  TokenStore,
} from "@folio/oracle-basic";
import { createFxRates } from "./fx-service";
import { createPlatforms } from "./platforms-service";
import { createTokens, type Tokens } from "./tokens";
import { BASELINE_VENDOR, pickVendor } from "./vendors";

export interface CreateOracleConfig {
  apiKey?: string;
  // 活跃行情源(用户设置,P3-3 注入);缺省 = baseline(CoinGecko),无需设置。
  activeVendor?: string;
  // store 实现由调用方(app)注入:D1 在 @folio/db,oracle 不依赖它。三类各自的 store 分开传。
  createTokenStore: (source: TokenRef["source"]) => TokenStore;
  platformStore: PlatformStore;
  fxStore: FxStore;
  // 测试注入:直接覆盖代币 provider(跳过 vendor 路由),避免真网络。
  provider?: TokenProvider;
}

// 统一 Oracle 门面(Phase 3,#79)。对外一个入口,对内组合 tokens/platforms/fx 三服务、不拆其实现。
// 三服务经 sub-service 暴露 —— 纯模型层(overview-model / revalue / enrichBalances)按接口隔离只依赖
// 各自窄契约(Tokens / Platforms / FxRates),故门面透出实例而非把方法拍平重命名。
export interface Oracle {
  readonly tokens: Tokens;
  readonly platforms: Platforms;
  readonly fx: FxRates;
}

// 组装入口:按 activeVendor 为每类能力选 provider/source(缺能力回退 baseline),再拼三服务。
// 本片仅 CoinGecko 一源 → 路由退化为恒等,兜底路径就位(P3-5 起接 DefiLlama)。
export function createOracle(cfg: CreateOracleConfig): Oracle {
  const { apiKey, activeVendor = BASELINE_VENDOR } = cfg;

  // 代币面(search/meta/prices)整体跟随声明 tokenMeta 的源 —— identity 恒在 baseline(CoinGecko);
  // 价格分源路由(DefiLlama 只供 prices)留待 P3-5/P3-6。测试可用 cfg.provider 直接覆盖。
  const tokenVendor = pickVendor("tokenMeta", activeVendor);
  const provider = cfg.provider ?? tokenVendor.tokenProvider?.({ apiKey });
  const platformSource = pickVendor("platformMeta", activeVendor).platformSource?.({ apiKey });
  const fxSource = pickVendor("fxRates", activeVendor).fxSource?.({ apiKey });
  if (!platformSource || !fxSource) {
    // baseline(CoinGecko)声明全部能力 → pickVendor 兜底后工厂必在场;缺失即注册表配错。
    throw new Error("oracle: baseline vendor missing platform/fx source");
  }

  return {
    tokens: createTokens({ apiKey, createStore: cfg.createTokenStore, provider }),
    platforms: createPlatforms({ source: platformSource, store: cfg.platformStore }),
    fx: createFxRates({ source: fxSource, store: cfg.fxStore }),
  };
}
