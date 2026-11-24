import { PerpEquity, PerpPosition, Spot } from "@folio/connectors-basic";
import { binanceBalance } from "@folio/upstreams";
import { z } from "zod";
import { defineConnector } from "../connector";
import { apiKeyCreds } from "./api-key-creds";

const BINANCE_LOGO = "https://assets.coingecko.com/markets/images/52/large/binance.jpg";

export const binance = defineConnector({
  id: "binance",
  label: "Binance",
  logo: BINANCE_LOGO,
  account: { creds: apiKeyCreds },
  balance: {
    schema: z.discriminatedUnion("kind", [Spot, PerpEquity, PerpPosition]),
    providers: [binanceBalance],
  },
});
