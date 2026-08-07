// 参考层的稳定域常量(原则 #8:volatile 的进 env,稳定的进这里)。
// 沿用现有名字与数值(`oracle-basic/src/constants.ts`),**不含任何数据源的东西** ——
// `OVERRIDES`(symbol → 某家 coin id 的策展小表)逐条写的都是那一家的 id,归 adapter(ADR 0023)。

// —— symbol 消歧门控 ——
export const RESOLUTION_TOP_RANK = 50; // 市值 top-N 内即可信(高置信)
export const RESOLUTION_DOMINANCE = 5; // 最佳须如此倍数地碾压次席(rank 比)才算高置信

// —— 缓存 TTL ——
// warm blob 是**目录**(symbol/名/图/排名),按目录的寿命定 —— 它几乎不变。以前是 30min,
// 理由是「它承载价」,结果整份目录被最短的那个字段拖着刷,而 mint 在写路径上为此出网(#216)。
// 现在价的新鲜度由读者按 blob 的 `asOf` 自己判(见 entry/warm.ts 与它的三个读者)。
//
// 这个值决定的是**后台预热多久刷一次目录** —— 一周。会因此变化的只有「谁新进了前 1000」
// 与排名,而排名只喂那两道很粗的门槛(前 50 / 5 倍碾压),隔一周毫无影响。
// 写路径(mint)一次都不看它:有就用、多旧都用(见 `warmCatalogue`)。
export const WARM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d(目录,近静态)
export const PRICE_TTL_MS = 30 * 60 * 1000; // 30min(长尾价;过期=stale 不删,SWR)
// name/logo 近乎静态,与 warm/price 的短 TTL 解耦:否则 warm 一过期,展示就丢 logo/名。
export const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
// 汇率**不是价**:法币之间一天动千分之几,没有理由跟长尾币价共用 30min。旧 oracle 一直是 6h,
// 搬过来时沿用 —— 短 TTL 唯一的作用是让预热多刷十二次,而读路径本来就软过期(拿最近值)。
export const FX_TTL_MS = 6 * 60 * 60 * 1000; // 6h(法币汇率,慢变)
export const PLATFORM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d(链/场馆的名与图,近静态)
// **否定缓存**的 TTL:问过上游、它的链表里没有这个键。短得多 —— 新链随时可能被收录,
// 而记住「没有」的唯一目的是别让每一次预热都为了这一个键重拉整张链表。
export const PLATFORM_NEG_TTL_MS = 24 * 60 * 60 * 1000; // 1d

// 预热深度(top-N markets)与默认选币下拉条数。
export const DEFAULT_TOP_N = 1000;
export const TOP_TOKENS_LIMIT = 50;

// —— 历史价日桶(#148 / ADR 0019)——
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const dayBucketOf = (ms: number): number => Math.floor(ms / MS_PER_DAY);

// key 归一口径:store 只按 key 存/查,归一一律在调用方(这里)完成。
export const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();
