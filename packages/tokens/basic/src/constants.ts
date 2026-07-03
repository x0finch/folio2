import type { TokenIdentifier, TokenRef } from "./types";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as TokenIdentifier });

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
export const CONTRACT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d(合约→ref 解析稳定)
export const PRICE_TTL_MS = 30 * 60 * 1000; // 30min(长尾价)
// name/logo 近乎静态,与 warm/price 的短 TTL 解耦:否则每次 warm 一过期,富化就丢 logo/名(回退首字母)。
export const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d(名称/图标,近静态)
export const ABSENT_TTL_MS = 24 * 60 * 60 * 1000; // 1d(否定缓存)
