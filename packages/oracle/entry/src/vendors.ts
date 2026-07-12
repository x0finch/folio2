import type {
  FxSource,
  OracleCapability,
  OracleVendor,
  PlatformSource,
  TokenProvider,
} from "@folio/oracle-basic";
import {
  coinGeckoVendor,
  createCoinGeckoFxSource,
  createCoinGeckoPlatformSource,
  createCoinGeckoProvider,
} from "@folio/oracle-provider-coingecko";

// 一个 vendor 的「描述 + 各能力的具体实现工厂」。工厂当且仅当 vendor 声明了对应能力时在场
//(见 vendor.capabilities):prices+tokenMeta 共用一个 TokenProvider;platformMeta→PlatformSource;
// fxRates→FxSource。createOracle 据此按活跃源选实现,活跃源缺能力则回退 baseline。
export interface VendorImpl {
  readonly vendor: OracleVendor;
  readonly tokenSource?: (cfg: { apiKey?: string }) => TokenProvider;
  readonly platformSource?: (cfg: { apiKey?: string }) => PlatformSource;
  readonly fxSource?: (cfg: { apiKey?: string }) => FxSource;
}

// 缺能力回退的兜底源:CoinGecko 供全部四类能力,是 identity/meta/logo 的权威(见 ADR 0013)。
export const BASELINE_VENDOR = "coingecko";

const coingecko: VendorImpl = {
  vendor: coinGeckoVendor,
  tokenSource: createCoinGeckoProvider,
  platformSource: createCoinGeckoPlatformSource,
  fxSource: createCoinGeckoFxSource,
};

// vendor 注册表(Phase 3 仅 CoinGecko;P3-5 起挂 DefiLlama 的 prices 面)。
export const VENDORS: Record<string, VendorImpl> = { coingecko };

// 能力路由:活跃源声明该能力 → 用活跃源;否则回退 baseline。未知活跃源亦退化为 baseline。
export function pickVendor(capability: OracleCapability, activeVendor: string): VendorImpl {
  const baseline = VENDORS[BASELINE_VENDOR];
  const active = VENDORS[activeVendor] ?? baseline;
  return active.vendor.capabilities.has(capability) ? active : baseline;
}
