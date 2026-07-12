import type { OracleCapability, OracleVendor } from "@folio/oracle-basic";

// CoinGecko 作为 oracle vendor 的声明。Phase 1 仅代币面(prices / tokenMeta);
// platformMeta / fxRates 待 platforms/fx 折入 oracle 时补(#72)。
export const coinGeckoVendor: OracleVendor = {
  id: "coingecko",
  capabilities: new Set<OracleCapability>(["prices", "tokenMeta"]),
};
