// bybit **适配层**的常量(原则 #8)。端点路径 / base / 签名头 / retCode 名单全归 `@folio/bybit-client`
// ——那一半是「怎么跟上游说话」(ADR 0036)。下面这些**逐字搬来,值一个没改**。

// provider 的 id,同时是 `tokenRef.issued(...)` 的发行方标识。
export const PROVIDER_ID = "bybit";

// 稳定币按 1 美元估值兜底(资金/赚币无自带价、oracle 尚未回填时用)。含 USD1(World Liberty Financial
// USD)等新稳定币 —— 探测账户大头是 USD1。
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "DAI",
  "TUSD",
  "FDUSD",
  "USD1",
  "USDE",
  "USDD",
]);

// 赚币的两个分类 —— 分开拉、分开记失败,展示名进 Note 与 balance 的 note 文案。
export const EARN_CATEGORIES = [
  { category: "FlexibleSaving", label: "Flexible" },
  { category: "OnChain", label: "On-chain" },
] as const;
