import { defineConnector, PerpEquity, PerpPosition, Spot } from "@folio/connectors-basic";
import { z } from "zod";
import { binanceAccountCreds, binanceProvider } from "./provider";

const BINANCE_LOGO = "https://assets.coingecko.com/markets/images/52/large/binance.jpg";

export const binance = defineConnector({
  id: "binance",
  label: "Binance",
  logo: BINANCE_LOGO,
  account: { creds: binanceAccountCreds },
  balance: {
    schema: z.discriminatedUnion("kind", [Spot, PerpEquity, PerpPosition]),
    providers: [binanceProvider],
  },
});
