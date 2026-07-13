import type {
  FxSource,
  OracleCapability,
  OracleVendor,
  PlatformSource,
  PriceSource,
  TokenProvider,
} from "@folio/oracle-basic";
import {
  coinGeckoVendor,
  createCoinGeckoFxSource,
  createCoinGeckoPlatformSource,
  createCoinGeckoProvider,
} from "@folio/oracle-provider-coingecko";
import { createDefiLlamaProvider, defiLlamaVendor } from "@folio/oracle-provider-defillama";

// 一个 vendor 的「身份 + 各能力的实现工厂」。工厂当且仅当 vendor 供该能力时在场——路由(pickVendor)据
// 「字段在场与否」判定,不另存能力集。代币面拆两工厂:tokenMetaSource(目录/搜索,返回完整 TokenProvider
// 供代币服务消费)+ priceSource(点查取价,窄 PriceSource);platformMeta→platformSource;fxRates→fxSource。
export interface VendorImpl {
  readonly vendor: OracleVendor;
  readonly tokenMetaSource?: (cfg: { apiKey?: string }) => TokenProvider;
  readonly priceSource?: (cfg: { apiKey?: string }) => PriceSource;
  readonly platformSource?: (cfg: { apiKey?: string }) => PlatformSource;
  readonly fxSource?: (cfg: { apiKey?: string }) => FxSource;
}

// 能力 → VendorImpl 上对应的实现工厂字段。路由判「该字段在不在」取代旧的 capabilities.has(cap)。
const CAP_FIELD: Record<OracleCapability, keyof Omit<VendorImpl, "vendor">> = {
  tokenMeta: "tokenMetaSource",
  prices: "priceSource",
  platformMeta: "platformSource",
  fxRates: "fxSource",
};

// 缺能力回退的兜底源:CoinGecko 供全部四类能力,是 identity/meta/logo 的权威(见 ADR 0013)。
export const BASELINE_VENDOR = "coingecko";

// CoinGecko 挂满四个工厂;代币两面同源(createCoinGeckoProvider 返回完整 TokenProvider,既是目录面也是价面)。
const coingecko: VendorImpl = {
  vendor: coinGeckoVendor,
  tokenMetaSource: createCoinGeckoProvider,
  priceSource: createCoinGeckoProvider,
  platformSource: createCoinGeckoPlatformSource,
  fxSource: createCoinGeckoFxSource,
};

// DefiLlama 只挂 priceSource(点查取价)。无 tokenMetaSource/platform/fx → pickVendor 那几类回退 baseline。
// DefiLlama keyless,忽略 apiKey。
const defillama: VendorImpl = {
  vendor: defiLlamaVendor,
  priceSource: () => createDefiLlamaProvider(),
};

// vendor 注册表(#83:CoinGecko baseline + DefiLlama 可切换价格源)。
export const VENDORS: Record<string, VendorImpl> = { coingecko, defillama };

// 能力路由:活跃源挂了该能力的实现工厂 → 用活跃源;否则回退 baseline。未知活跃源亦退化为 baseline。
export function pickVendor(capability: OracleCapability, activeVendor: string): VendorImpl {
  const baseline = VENDORS[BASELINE_VENDOR];
  const active = VENDORS[activeVendor] ?? baseline;
  return active[CAP_FIELD[capability]] ? active : baseline;
}
