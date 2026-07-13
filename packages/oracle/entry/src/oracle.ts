import type {
  FxRates,
  FxStore,
  PlatformStore,
  Platforms,
  TokenRef,
  TokenStore,
} from "@folio/oracle-basic";
import { createFxRates } from "./services/fx";
import { createPlatforms } from "./services/platforms";
import { createTokens, type Tokens } from "./services/tokens";
import { BASELINE_VENDOR, pickSource } from "./vendors";

export interface CreateOracleConfig {
  apiKey?: string;
  // 活跃行情源(用户设置,P3-3 注入);缺省 = baseline(CoinGecko),无需设置。
  activeVendor?: string;
  // store 实现由调用方(app)注入:D1 在 @folio/db,oracle 不依赖它。三类都是**惰性工厂**(不是实例):
  // 门面按访问只建被碰的服务(见下 getter),store 也须延到那时才造 —— 否则 app 侧一拼 config 就把三个
  // store 全 new 出来(各含 getDb),`oracle.tokens` 也白建平台/汇率 store。代币工厂额外收 source:代币缓存
  // 按 source 分桶(ref 只对该源成立、warm 标记 `warm_as_of:<source>` 亦分源),多 vendor 共存(P3-5 起
  // DefiLlama)时每源一份;平台/汇率恒单源(CoinGecko 权威、baseline-only,见 ADR 0013),无需分桶 → 工厂零参。
  createTokenStore: (source: TokenRef["source"]) => TokenStore;
  createPlatformStore: () => PlatformStore;
  createFxStore: () => FxStore;
}

// 统一 Oracle 门面(Phase 3,#79)。对外一个入口,对内组合 tokens/platforms/fx 三服务、不拆其实现。
// 三服务经 sub-service 暴露 —— 纯模型层(overview-model / revalue / enrichBalances)按接口隔离只依赖
// 各自窄契约(Tokens / Platforms / FxRates),故门面透出实例而非把方法拍平重命名。
export interface Oracle {
  readonly tokens: Tokens;
  readonly platforms: Platforms;
  readonly fx: FxRates;
}

// 组装入口:按 activeVendor 为每类能力选 source(缺能力回退 baseline),再拼三服务。
// 本片仅 CoinGecko 一源 → 路由退化为恒等,兜底路径就位(P3-5 起接 DefiLlama)。
//
// 惰性:三服务经 getter 首访即建、建后记忆。调用方常只用其一(logo 端点只碰 tokens、货币只碰 fx),
// 故不预建另两套(省去其 source + store 构造)。app 侧 oracle 代理每次属性访问现造一份门面
// (见 server/oracle.ts,绑当前 env),配合本惰性 → 一次访问只建被碰的那一服务,不浪费。
export function createOracle(cfg: CreateOracleConfig): Oracle {
  const { apiKey, activeVendor = BASELINE_VENDOR } = cfg;
  let tokens: Tokens | undefined;
  let platforms: Platforms | undefined;
  let fx: FxRates | undefined;

  return {
    get tokens() {
      // 代币面(search/meta/prices)整体跟随 token 源 —— identity 恒在 baseline(CoinGecko);
      // 价格分源路由(DefiLlama 只供 price)留待 #83。
      if (!tokens) {
        const source = pickSource(activeVendor, "token")?.({ apiKey });
        tokens = createTokens({ apiKey, createStore: cfg.createTokenStore, source });
      }
      return tokens;
    },
    get platforms() {
      if (!platforms) {
        const source = pickSource(activeVendor, "platform")?.({ apiKey });
        // baseline(CoinGecko)挂全部工厂 → pickSource 兜底后必在场;缺失即注册表配错。
        if (!source) throw new Error("oracle: baseline vendor missing platform source");
        platforms = createPlatforms({ source, store: cfg.createPlatformStore() });
      }
      return platforms;
    },
    get fx() {
      if (!fx) {
        const source = pickSource(activeVendor, "fx")?.({ apiKey });
        if (!source) throw new Error("oracle: baseline vendor missing fx source");
        fx = createFxRates({ source, store: cfg.createFxStore() });
      }
      return fx;
    },
  };
}
