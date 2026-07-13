import type { OracleVendor } from "@folio/oracle-basic";

// DefiLlama 作为 oracle vendor 的身份声明。只供价格——注册表里它只挂 priceSource 工厂,身份/元信息/平台/
// 汇率无工厂 → pickVendor 缺该实现即回退 baseline(CoinGecko)。见 entry vendors.ts。
export const defiLlamaVendor: OracleVendor = { id: "defillama" };
