// @folio/platforms —— 平台元数据(链 ∪ 交易所/perp 的 name+logo)。数据源 CoinGecko。
// 契约 + CoinGecko 实现 + 服务,单包(CoinGecko 是唯一源,无需多 provider)。

export { createCoinGeckoPlatformSource } from "./coingecko";
export { type CreatePlatformsConfig, createPlatforms } from "./service";
export {
  PlatformError,
  type PlatformErrorCode,
  type PlatformMeta,
  type PlatformRow,
  type PlatformSource,
  type PlatformStore,
  type Platforms,
} from "./types";
