import type { OracleVendor } from "@folio/oracle-basic";

// CoinGecko 作为 oracle vendor 的身份声明。四类能力全供——具体由注册表(VendorImpl)挂满四个工厂体现,
// 不在此另存能力集(见 @folio/oracle-basic vendor.ts / entry vendors.ts pickVendor)。
export const coinGeckoVendor: OracleVendor = { id: "coingecko" };
