import type { CoinId, TokenRef } from "./types";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });

// symbol → 规范 `TokenRef` 的策展小表:majors + 已知撞名,优先于市值排名(防山寨撞名)。
// 键须为 `normalizeSymbol` 输出(大写)。大头仍靠 (链,合约) 与显式 coinId;此表只兜 symbol 来源。
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

// 缓存 TTL(供 P7.3 store 实现)。索引/元信息慢变,价快变,否定缓存中等。
export const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
export const TOKENINFO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
export const PRICE_TTL_MS = 10 * 60 * 1000; // 10min
export const ABSENT_TTL_MS = 24 * 60 * 60 * 1000; // 1d
