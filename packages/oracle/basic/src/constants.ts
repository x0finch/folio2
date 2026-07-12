import type { CgkCoinId, TokenRef } from "./types";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });

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
export const TOKEN_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d(tokenKey 索引行;每次 sync 顺延)
export const PRICE_TTL_MS = 30 * 60 * 1000; // 30min(长尾价;过期=stale 不删,SWR)
// name/logo 近乎静态,与 warm/price 的短 TTL 解耦:否则每次 warm 一过期,富化就丢 logo/名(回退首字母)。
export const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d(名称/图标,近静态)
export const CGK_RECHECK_TTL_MS = 24 * 60 * 60 * 1000; // 1d(CGK 未收录的复查间隔,替代旧否定缓存)

// —— 展示分组种子(P2,ADR-0001)——
// TokenGroup = 用户心智里"一个币"的家族;只并 CGK 故意拆开、用户视作同一的币。
// 组定义(展示 symbol/名)。组的 logo 留空 → 展示时取主成员。
export interface TokenGroupDef {
  displaySymbol: string; // normalizeSymbol 口径(大写)
  name: string;
}
export const TOKEN_GROUPS = {
  usdt: { displaySymbol: "USDT", name: "Tether USD" },
  usdc: { displaySymbol: "USDC", name: "USD Coin" },
  dai: { displaySymbol: "DAI", name: "Dai" },
} as const satisfies Record<string, TokenGroupDef>;
export type TokenGroupKey = keyof typeof TOKEN_GROUPS;

// CGK coin id → 组。只收 CGK 故意拆开的桥接/变体家族;canonical 成员必收,桥接变体逐个按 CGK 实查确认后加。
// 【红线】weth≠eth、wbtc≠btc、staked 衍生≠本尊 —— 默认不并,不入此表(ADR-0002 的精神:只并已确认同质的)。
// 起步:canonical(tether/usd-coin/dai)+ 研究已确认的桥接 usdt0(Arbitrum 等);其余桥接变体(bridged-*,
// 各链 usdt.e / usdc.e 独立 coin)执行 sync 见到实际 cgk id 后按 CGK /coins/list 核对再增补。
export const GROUP_MEMBERSHIP: Readonly<Record<string, TokenGroupKey>> = {
  tether: "usdt",
  usdt0: "usdt", // Arbitrum 等桥接 USDT(CGK 归 usdt0,非 tether)
  "usd-coin": "usdc",
  dai: "dai",
};
