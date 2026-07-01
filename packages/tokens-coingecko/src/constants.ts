// CoinGecko 接入常量(具名,不散落)。基址按 key 类型选;端点路径固定;分页上限/默认 topN 见下。

export const CG_BASE_FREE = "https://api.coingecko.com/api/v3";
export const CG_BASE_PRO = "https://pro-api.coingecko.com/api/v3";

export const EP_ASSET_PLATFORMS = "/asset_platforms";
export const EP_COINS = "/coins"; // per-contract: `/coins/{platform}/contract/{addr}`
export const EP_COINS_MARKETS = "/coins/markets";
export const EP_SIMPLE_PRICE = "/simple/price";
export const EP_SEARCH = "/search";

// 搜索返回截断(autocomplete 下拉只需前几个)。
export const SEARCH_LIMIT = 10;

// 鉴权头(demo key 走 free 基址,pro key 走 pro 基址)。
export const HEADER_DEMO = "x-cg-demo-api-key";
export const HEADER_PRO = "x-cg-pro-api-key";

// CGK 的 Cloudflare WAF 对**无 `User-Agent`** 的请求返 403(CF Workers 的 fetch 默认不带 UA)。
// 显式带标识性 UA,search/markets/contract 等所有端点才不被拦(dev + 生产同理)。
export const USER_AGENT = "folio-portfolio-tracker/1.0 (+https://github.com/x0finch/folio)";

// /coins/markets 每页上限(CGK 硬上限)+ 默认拉取深度。
export const PER_PAGE_MAX = 250;
export const DEFAULT_TOP_N = 1000;

// markets 多窗口涨跌(7d/30d 为 P8.1 预留;TokenPrice 暂只存 24h)。
export const PRICE_CHANGE_WINDOWS = "24h,7d,30d";

// 单基准计价币。token 层一律 USD;多法币在展示层用 USD→法币汇率换算(P8.6)。
export const VS_USD = "usd";
