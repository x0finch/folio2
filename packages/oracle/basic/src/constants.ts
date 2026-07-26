import type { TokenRef } from "./types";
import { CGK_VENDOR, cgkRef as cg } from "./vendor";

// —— 「这个命名者是不是一条链」的临时判据(ADR 0021 / #192)——
// 文法收窄前,`native` / `<assetNs>:<addr>` 的形状自己就说明了「这是链上寻址」;去掉 assetNs 后
// `evm:1/0xa0b8…` 与 `binance/USDC` 在串上不可分辨。真正的答案是**平台由 provider 随余额直接报**
// (#193),届时本表连同所有 `chainOf` 式判断一起删除。在那之前用「非链命名者」的反向名单兜着 ——
// 它短、稳定,且比按形状猜更诚实:场馆(CEX / perp DEX)与数据源各自只有这几个。
// 注:`manual` 不在此 —— 手记从不作命名者,它的持仓报的是 `coingecko/<id>`。
const NON_CHAIN_NAMERS: ReadonlySet<string> = new Set([
  CGK_VENDOR,
  "binance",
  "okx",
  "hyperliquid",
]);

// tokenRef 的这个命名者是一条链吗(而不是场馆 / 数据源)。
export const isChainNamer = (namer: string): boolean => !NON_CHAIN_NAMERS.has(namer);

// symbol → 规范 `TokenRef` 的策展小表:majors + 已知撞名,优先于市值排名(防山寨撞名)。
// 键须为 `normalizeSymbol` 输出(大写)。大头仍靠 (链,合约) 与显式 identifier;此表只兜 symbol 来源。
export const OVERRIDES: Readonly<Record<string, TokenRef>> = {
  BTC: cg("bitcoin"),
  ETH: cg("ethereum"),
  USDT: cg("tether"),
  USDC: cg("usd-coin"),
  BNB: cg("binancecoin"),
  SOL: cg("solana"),
  XRP: cg("ripple"),
  ADA: cg("cardano"),
  DOGE: cg("dogecoin"),
  TRX: cg("tron"),
  TON: cg("the-open-network"),
  DAI: cg("dai"),
  AVAX: cg("avalanche-2"),
  SUI: cg("sui"),
  ATOM: cg("cosmos"),
};

// 符号消歧门控阈值(`pickByConfidence`)。
export const RESOLUTION_TOP_RANK = 50; // 市值 top-N 内即可信(高置信)
export const RESOLUTION_DOMINANCE = 5; // 最佳须如此倍数地碾压次席(rank 比)才算高置信

// 预热深度(top-N markets)。
export const DEFAULT_TOP_N = 1000;

// 默认选币下拉(空输入)展示的市值 top-N 条数(P7.4.5)。
export const TOP_TOKENS_LIMIT = 50;

// 缓存 TTL(供 store 实现 / refreshWarm 门控)。warm 承载价要新鲜、合约解析稳定、否定中等。
// (chain 的源内映射 TTL 由各 source 自管,不在此。)
export const WARM_TTL_MS = 30 * 60 * 1000; // 30min(warm 承载价,要新鲜)
export const TOKEN_REF_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d(tokenRef 索引行;每次 sync 顺延)
export const PRICE_TTL_MS = 30 * 60 * 1000; // 30min(长尾价;过期=stale 不删,SWR)
// name/logo 近乎静态,与 warm/price 的短 TTL 解耦:否则每次 warm 一过期,富化就丢 logo/名(回退首字母)。
export const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d(名称/图标,近静态)
export const CGK_RECHECK_TTL_MS = 24 * 60 * 60 * 1000; // 1d(CGK 未收录的复查间隔,替代旧否定缓存)

// —— 历史价日桶(#148 / ADR 0019)——
// 历史价按 UTC 日桶缓存/采样。dayBucketOf(ms) = 该时刻所属 UTC 日的整数索引;日桶起点 = bucket * MS_PER_DAY。
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const dayBucketOf = (ms: number): number => Math.floor(ms / MS_PER_DAY);
