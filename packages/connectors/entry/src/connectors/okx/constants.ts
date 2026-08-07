// okx **适配层**的常量(原则 #8)。端点路径 / base / 签名头 / 业务码名单全归 `@folio/okx-client` ——
// 那一半是「怎么跟上游说话」,这一半是「怎么把上游的话翻成 folio 的 Balance」(ADR 0036)。
// 下面这几个**逐字搬来,一个值都没改** —— 常量的值就是产品行为(测试抓到过我顺手换了 logo)。

// provider 的 id,同时是 `tokenRef.issued(...)` 的发行方标识。
export const PROVIDER_ID = "okx";

// 稳定币按 1 美元估值兜底(交易账户没这个币、oracle 尚未回填时用)。与 binance 同口径。
export const STABLECOINS: ReadonlySet<string> = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD"]);

// earn 桶残差阈值:拉到的 earn 子项加总与 asset-valuation 的 earn 桶差额 > 此值才挂"未细分"account 级 Note。
export const EARN_RESIDUAL_MIN_USD = 1;

// 未细分赚币合成聚合行的 logo(OKX 品牌 X 形标,quincunx)。内嵌 data-URI:自包含、离线可用、
// 客户端零第三方 CDN(ADR 0008);走 tokenLogoUrl 的 data: 直挂分支,不经 /api/logo 代理。
export const OKX_EARN_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzExMTMxOCIvPjxnIGZpbGw9IiNmZmYiPjxyZWN0IHg9IjQiIHk9IjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PHJlY3QgeD0iMTUuNCIgeT0iNCIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI5LjciIHk9IjkuNyIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI0IiB5PSIxNS40IiB3aWR0aD0iNC42IiBoZWlnaHQ9IjQuNiIvPjxyZWN0IHg9IjE1LjQiIHk9IjE1LjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PC9nPjwvc3ZnPg==";
