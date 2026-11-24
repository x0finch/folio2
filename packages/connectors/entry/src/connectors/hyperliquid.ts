import { PerpEquity, PerpPosition } from "@folio/connectors-basic";
import { hyperliquidBalance } from "@folio/upstreams";
import { z } from "zod";
import { defineConnector } from "../connector";
import { evmAccountCreds } from "./evm/creds";

const HYPERLIQUID_LOGO = "https://assets.coingecko.com/coins/images/50882/large/hyperliquid.jpg";

export const hyperliquid = defineConnector({
  id: "hyperliquid",
  label: "Hyperliquid",
  logo: HYPERLIQUID_LOGO,
  account: { creds: evmAccountCreds },
  balance: {
    schema: z.discriminatedUnion("kind", [PerpEquity, PerpPosition]),
    providers: [hyperliquidBalance],
  },
});
