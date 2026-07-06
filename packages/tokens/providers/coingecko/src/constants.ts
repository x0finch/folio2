// CoinGecko 接入常量(token 侧)。HTTP 基址/鉴权头/UA 已移入 @folio/coingecko-client;
// 这里 re-export 保持既有导入面(constants 曾对外提供这些常量,含测试)。

export {
  CG_BASE_FREE,
  CG_BASE_PRO,
  HEADER_DEMO,
  HEADER_PRO,
  USER_AGENT,
} from "@folio/coingecko-client";

// endpoint 路径已收进 @folio/coingecko-client 的 SDK 方法(不再声明 EP_*)。

// 搜索返回截断(autocomplete 下拉只需前几个)。
export const SEARCH_LIMIT = 10;

// /coins/markets 每页上限(CGK 硬上限)+ 默认拉取深度。
export const PER_PAGE_MAX = 250;
export const DEFAULT_TOP_N = 1000;

// markets 多窗口涨跌(7d/30d 为 P8.1 预留;TokenPrice 暂只存 24h)。
export const PRICE_CHANGE_WINDOWS = "24h,7d,30d";

// 单基准计价币。token 层一律 USD;多法币在展示层用 USD→法币汇率换算(P8.6)。
export const VS_USD = "usd";
