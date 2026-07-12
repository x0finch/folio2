import type { OracleCapability, OracleVendor } from "@folio/oracle-basic";

// CoinGecko 作为 oracle vendor 的声明。platforms/fx 折入后(#72)四类能力全有实现,故全声明。
export const coinGeckoVendor: OracleVendor = {
  id: "coingecko",
  capabilities: new Set<OracleCapability>(["prices", "tokenMeta", "platformMeta", "fxRates"]),
};
