import type {
  FxRates,
  FxStore,
  PlatformStore,
  Platforms,
  TokenRef,
  TokenStore,
} from "@folio/oracle-basic";
import {
  createCoinGeckoFxSource,
  createCoinGeckoPlatformSource,
} from "@folio/oracle-source-coingecko";
import { createFxRates } from "./services/fx";
import { createPlatforms } from "./services/platforms";
import { createTokens, type Tokens } from "./services/tokens";

export interface CreateOracleConfig {
  apiKey?: string;
  // store 实现由调用方(app)注入:D1 在 @folio/db,oracle 不依赖它。三类都是**惰性工厂**(不是实例):
  // 门面按访问只建被碰的服务(见下 getter),store 也须延到那时才造 —— 否则 app 侧一拼 config 就把三个
  // store 全 new 出来(各含 getDb),`oracle.tokens` 也白建平台/汇率 store。代币工厂额外收 source:代币缓存
  // 按 source 分桶(ref 只对该源成立、warm 标记 `warm_as_of:<source>` 亦分源;当前恒 CoinGecko,#73 中立身份
  // 仍以此键 token_vendor_ids)→ 保留分桶签名;平台/汇率恒单源(CoinGecko,见 ADR 0005/0006),工厂零参。
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

// 组装入口:三服务皆由 CoinGecko 供源(价 / identity / 平台 / 汇率同源,ADR 0013 的估值 policy
// self-first/source-first 是「自填价 vs 源价」正交维度,与源无关,由 valuate 纯函数在消费层裁决)。
// 运行时换价源(DefiLlama / activeVendor 路由)已废止,见 ADR 0014。
//
// 惰性:三服务经 getter 首访即建、建后记忆。调用方常只用其一(logo 端点只碰 tokens、货币只碰 fx),
// 故不预建另两套(省去其 source + store 构造)。app 侧 oracle 代理每次属性访问现造一份门面
// (见 server/oracle.ts,绑当前 env),配合本惰性 → 一次访问只建被碰的那一服务,不浪费。
export function createOracle(cfg: CreateOracleConfig): Oracle {
  const { apiKey } = cfg;
  let tokens: Tokens | undefined;
  let platforms: Platforms | undefined;
  let fx: FxRates | undefined;

  return {
    get tokens() {
      // createTokens 缺省 source = CoinGecko(见其定义),故此处不必显式造源。
      if (!tokens) {
        tokens = createTokens({ apiKey, createStore: cfg.createTokenStore });
      }
      return tokens;
    },
    get platforms() {
      if (!platforms) {
        platforms = createPlatforms({
          source: createCoinGeckoPlatformSource({ apiKey }),
          store: cfg.createPlatformStore(),
        });
      }
      return platforms;
    },
    get fx() {
      if (!fx) {
        fx = createFxRates({
          source: createCoinGeckoFxSource({ apiKey }),
          store: cfg.createFxStore(),
        });
      }
      return fx;
    },
  };
}
