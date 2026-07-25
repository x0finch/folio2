// 参考层的稳定域常量(原则 #8:volatile 的进 env,稳定的进这里)。

// —— symbol 消歧门控(与今天的口径一致,见 confidence.ts)——
export const RESOLUTION_TOP_RANK = 50; // 市值 top-N 内即可信
export const RESOLUTION_DOMINANCE = 5; // 最佳须如此倍数地碾压次席(rank 比)才算有把握

// —— 缓存 TTL ——
export const WARM_TTL_MS = 30 * 60 * 1000; // 30min(warm 承载价,要新鲜)
export const PRICE_TTL_MS = 30 * 60 * 1000; // 30min(长尾价;过期=stale 不删,SWR)
// name/logo 近乎静态,与 warm/price 的短 TTL 解耦:否则 warm 一过期,展示就丢 logo/名。
export const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const FX_TTL_MS = 30 * 60 * 1000; // 30min(汇率)
export const PLATFORM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d(链/场馆的名与图,近静态)

// 预热深度(top-N markets)与默认选币下拉条数。
export const DEFAULT_TOP_N = 1000;
export const TOP_TOKENS_LIMIT = 50;

// —— 历史价日桶(#148 / ADR 0019)——
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const dayBucketOf = (ms: number): number => Math.floor(ms / MS_PER_DAY);

// —— CoinGecko 作为命名者 ——
// 「这个币被 CoinGecko 认出来了吗」= 它有没有这个命名者的 ref(不存额外状态,ADR 0021)。
export const CGK_NAMER = "coingecko";

// key 归一口径:store 只按 key 存/查,归一一律在调用方(这里)完成。
export const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();
