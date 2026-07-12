import type { OracleCapability, OracleVendor } from "@folio/oracle-basic";

// DefiLlama 作为 oracle vendor 的声明。只供价格 —— 身份/元信息/平台/汇率仍走 baseline(CoinGecko)。
// createOracle 的 capability 路由据此:活跃源为 defillama 时仅 prices 走它,其余回退 baseline(见 #79)。
export const defiLlamaVendor: OracleVendor = {
  id: "defillama",
  capabilities: new Set<OracleCapability>(["prices"]),
};
