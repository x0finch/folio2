import type { TokenPriceHistoryStore, TokenStore } from "@folio/oracle-basic";
import { createTokens, type Tokens } from "./services/tokens";

export interface CreateOracleConfig {
  apiKey?: string;
  // store 实现由调用方(app)注入:D1 在 @folio/db,oracle 不依赖它。都是**惰性工厂**(不是实例):
  // 门面按访问只建被碰的服务(见下 getter),store 也须延到那时才造。代币工厂额外收 source:代币缓存
  // 按 source 分桶(ref 只对该源成立、warm 标记 `warm_as_of:<source>` 亦分源;当前恒 CoinGecko,#73 中立身份
  // 仍以此键 token_vendor_ids)→ 保留分桶签名。
  createTokenStore: (source: string) => TokenStore;
  // 历史日价缓存(#148 / ADR 0019)。可选:不传 → 无历史缓存(priceSeries 现取不落库)。
  createPriceHistoryStore?: () => TokenPriceHistoryStore;
}

// 统一 Oracle 门面(Phase 3,#79)。对外一个入口,对内组合各服务、不拆其实现。
// 服务经 sub-service 暴露 —— 纯模型层(overview-model / revalue / enrichBalances)按接口隔离只依赖
// 各自窄契约(Tokens),故门面透出实例而非把方法拍平重命名。
//
// **汇率与平台都已经不在这里了**(#202b):它们搬进了 `@folio/oracle2`(per-user 缓存 +
// 各自独立的上游端口)。只剩代币,随选币与预热两片一起退场。
export interface Oracle {
  readonly tokens: Tokens;
}

// 组装入口:由 CoinGecko 供源(价 / identity 同源,ADR 0013 的估值 policy
// self-first/source-first 是「自填价 vs 源价」正交维度,与源无关,由 valuate 纯函数在消费层裁决)。
// 运行时换价源(DefiLlama / activeVendor 路由)已废止,见 ADR 0014。
//
// 惰性:服务经 getter 首访即建、建后记忆。app 侧 oracle 代理每次属性访问现造一份门面
// (见 server/oracle.ts,绑当前 env),配合本惰性 → 一次访问只建被碰的那一服务,不浪费。
export function createOracle(cfg: CreateOracleConfig): Oracle {
  const { apiKey } = cfg;
  let tokens: Tokens | undefined;

  return {
    get tokens() {
      // createTokens 缺省 source = CoinGecko(见其定义),故此处不必显式造源。
      if (!tokens) {
        tokens = createTokens({
          apiKey,
          createStore: cfg.createTokenStore,
          createPriceHistoryStore: cfg.createPriceHistoryStore,
        });
      }
      return tokens;
    },
  };
}
