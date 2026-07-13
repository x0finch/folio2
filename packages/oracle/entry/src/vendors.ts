import type { FxSource, PlatformSource, PriceSource, TokenSource } from "@folio/oracle-basic";
import {
  createCoinGeckoFxSource,
  createCoinGeckoPlatformSource,
  createCoinGeckoSource,
} from "@folio/oracle-source-coingecko";
import { createDefiLlamaSource } from "@folio/oracle-source-defillama";

// 一个 vendor 供哪几类数据,由它挂了哪些实现工厂决定 —— 没有独立的能力集,也不按能力重复挂同一 client。
// · token —— 完整代币 client(目录+价,= TokenSource)。身份/元信息权威才有(CoinGecko)。代币服务消费它。
// · price —— **专用**价源(无目录,= PriceSource)。如 DefiLlama。多能力 vendor(CoinGecko)不挂,
//            其价走 token 的价面 → 价格消费方回退 `price ?? token`(#83 双源消费时接),故此处不重复挂。
// · platform / fx —— 各一。选源按「取哪个字段」判空回退(见 pickSource)。
export interface VendorImpl {
  readonly token?: (cfg: { apiKey?: string }) => TokenSource;
  readonly price?: (cfg: { apiKey?: string }) => PriceSource;
  readonly platform?: (cfg: { apiKey?: string }) => PlatformSource;
  readonly fx?: (cfg: { apiKey?: string }) => FxSource;
}

// 缺能力回退的兜底源:CoinGecko 供全部四类,是 identity/meta/logo 的权威(见 ADR 0013)。
export const BASELINE_VENDOR = "coingecko";

// CoinGecko:一个 client(createCoinGeckoSource = 完整 TokenSource)供 token 面;platform/fx 各一。
// 不挂 price —— 它非专用价源,价走 token(见上)。
const coingecko: VendorImpl = {
  token: createCoinGeckoSource,
  platform: createCoinGeckoPlatformSource,
  fx: createCoinGeckoFxSource,
};

// DefiLlama:只挂 price(专用价源,无目录)。无 token/platform/fx → pickSource 那几类回退 baseline。
// DefiLlama keyless,忽略 apiKey。
const defillama: VendorImpl = {
  price: () => createDefiLlamaSource(),
};

// vendor 注册表(#83:CoinGecko baseline + DefiLlama 可切换价格源)。key 即活跃源标识(activeVendor)。
export const VENDORS: Record<string, VendorImpl> = { coingecko, defillama };

// 选源:活跃源挂了该工厂字段 → 用活跃源的;否则回退 baseline。未知活跃源亦退化为 baseline。
// 「能力」即「取哪个字段」—— 调用方直接给字段名(keyof 受检),不再有能力名/映射表这层中转。
export function pickSource<K extends keyof VendorImpl>(
  activeVendor: string,
  field: K,
): VendorImpl[K] {
  const active = VENDORS[activeVendor] ?? VENDORS[BASELINE_VENDOR];
  return active[field] ?? VENDORS[BASELINE_VENDOR][field];
}
