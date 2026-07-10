// Binance Spot API 常量(不硬编码散落,见原则 #8)。
export const BINANCE_API_BASE = "https://api.binance.com";
export const ACCOUNT_PATH = "/api/v3/account"; // SIGNED,USER_DATA(只读 key 即可)
export const TICKER_PRICE_PATH = "/api/v3/ticker/price"; // 公开免签,全市场价
export const API_KEY_HEADER = "X-MBX-APIKEY";
export const RECV_WINDOW = 5000; // 请求有效窗口(ms)

// 计价用的报价币:asset 在 USD 估值 = amount × price(`${asset}USDT`)。
export const QUOTE_ASSET = "USDT";
// 视为 ≈1 USD 的稳定币(无 `${asset}USDT` 自对)。
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "FDUSD",
  "TUSD",
  "DAI",
]);

// detail 块标签 —— app i18n key(前端 translate 解析,跟随中英双语;ADR 0010:标签用 i18n key,非写死文案)。
// 复用 apps/web 的 Overview 命名空间 CEX 键(cexBreakdown / cexAvailable / cexLocked)。
export const DETAIL_LABEL = {
  breakdown: "Overview.cexBreakdown",
  available: "Overview.cexAvailable",
  locked: "Overview.cexLocked",
} as const;
