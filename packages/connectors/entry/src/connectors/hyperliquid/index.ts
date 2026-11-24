import { defineConnector, PerpEquity, PerpPosition } from "@folio/connectors-basic";
import { z } from "zod";
import { hyperliquidAccountCreds, hyperliquidProvider } from "./provider";

const HYPERLIQUID_LOGO = "https://assets.coingecko.com/coins/images/50882/large/hyperliquid.jpg";

export const hyperliquid = defineConnector({
  id: "hyperliquid",
  label: "Hyperliquid",
  logo: HYPERLIQUID_LOGO,
  account: { creds: hyperliquidAccountCreds },
  balance: {
    schema: z.discriminatedUnion("kind", [PerpEquity, PerpPosition]),
    providers: [hyperliquidProvider],
  },
});
