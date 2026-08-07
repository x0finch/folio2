// @folio/coingecko-client —— CoinGecko v3 的请求层。
//
// 只跟上游说话,**不带任何 folio 语义** —— 认币、估值 policy、ref 索引全在 oracle 那边(ADR 0036)。
//
// 与被它替掉的那版(Promise + `@folio/shared` 的手搓传输层)的三处**行为差异**,都是刻意的:
//   · **不自带重试** —— 老版把 `retry: {...}` 收进传输层,于是这个仓库对「怎么重试」有过三份
//     答案(这里、`@folio/sync`、我在 client-core 里写了又删的那份)。重试是调用方的事:
//     `Effect.retry(策略)`,而闸在 effect 里面,「闸必须在重试内层」那条语义自动成立
//   · **没有 `sleep` 注入口** —— 那是老版为了让测试能快进而开的;Effect 的 `TestClock` 直接解决,
//     不必在生产签名上留一个只有测试用的参数
//   · **错误是共享的四类**(`Upstream*Error`),不是本包自己的 `CoinGeckoError`。
//     注意老版把 401/403 归成 `UPSTREAM_ERROR`(理由:CGK 没有「凭据被拒」这条独立语义,
//     401/403 就是 key 不对或超配额);共享归类会把它们判成「凭据问题」——**这是行为变化**,
//     而且是往好的方向:key 不对时重试确实没用,而老版按 `status >= 500` 判可重试,
//     恰好也不重试 401/403,所以实际重试行为不变,只是名字更准
export {
  CoinGeckoClient,
  type CoinGeckoClientApi,
  type CoinGeckoConfig,
  type CoinsMarketChartRangeParams,
  type CoinsMarketsParams,
  make,
  type SimplePriceParams,
} from "./client";
export { CG_BASE_FREE, CG_BASE_PRO, USER_AGENT } from "./constants";
export type {
  AssetPlatform,
  CoinContract,
  CoinListItem,
  DerivativesExchange,
  Exchange,
  ExchangeRates,
  MarketChartRange,
  MarketCoin,
  SearchResult,
  SimplePriceMap,
} from "./types";
