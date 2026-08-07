import { defineConnector, PerpEquity, PerpPosition } from "@folio/connectors-basic";
import { z } from "zod";
import { hyperliquidAccountCreds, hyperliquidProvider } from "./provider";

// hyperliquid connector manifest —— 永续 DEX,只读地址即查(无签名、无 key)。
// 适配层住在这个目录(ADR 0036),请求那一半在 `@folio/hyperliquid-client`。
const HYPERLIQUID_LOGO = "https://assets.coingecko.com/coins/images/50882/large/hyperliquid.jpg";

export const hyperliquid = defineConnector({
  id: "hyperliquid",
  label: "Hyperliquid",
  logo: HYPERLIQUID_LOGO,
  account: { creds: hyperliquidAccountCreds },
  // 多 kind:权益行 + 仓位行。
  balance: {
    schema: z.discriminatedUnion("kind", [PerpEquity, PerpPosition]),
    providers: [hyperliquidProvider],
  },
});
