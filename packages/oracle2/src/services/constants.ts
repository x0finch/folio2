// 参考层的稳定域常量(原则 #8:volatile 的进 env,稳定的进这里)。
// 沿用现有名字与数值(`oracle-basic/src/constants.ts`),**不含任何数据源的东西** ——
// `OVERRIDES`(symbol → 某家 coin id 的策展小表)逐条写的都是那一家的 id,归 adapter(ADR 0023)。

// —— symbol 消歧门控 ——
export const RESOLUTION_TOP_RANK = 50; // 市值 top-N 内即可信(高置信)
export const RESOLUTION_DOMINANCE = 5; // 最佳须如此倍数地碾压次席(rank 比)才算高置信

// —— 缓存 TTL ——
export const WARM_TTL_MS = 30 * 60 * 1000; // 30min(warm 承载价,要新鲜)
export const PRICE_TTL_MS = 30 * 60 * 1000; // 30min(长尾价;过期=stale 不删,SWR)
// name/logo 近乎静态,与 warm/price 的短 TTL 解耦:否则 warm 一过期,展示就丢 logo/名。
export const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const FX_TTL_MS = 30 * 60 * 1000; // 30min
export const PLATFORM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d(链/场馆的名与图,近静态)

// 预热深度(top-N markets)与默认选币下拉条数。
export const DEFAULT_TOP_N = 1000;
export const TOP_TOKENS_LIMIT = 50;

// —— 历史价日桶(#148 / ADR 0019)——
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const dayBucketOf = (ms: number): number => Math.floor(ms / MS_PER_DAY);

// key 归一口径:store 只按 key 存/查,归一一律在调用方(这里)完成。
export const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();
