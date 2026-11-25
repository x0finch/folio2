import { Spot } from "@folio/connectors-basic";
import { bybitBalance } from "@folio/upstreams";
import { defineConnector } from "../connector";
import { apiKeyCreds } from "./api-key-creds";

const BYBIT_LOGO = "https://assets.coingecko.com/markets/images/698/large/bybit_spot.png";

export const bybit = defineConnector({
  id: "bybit",
  label: "Bybit",
  logo: BYBIT_LOGO,
  account: { creds: apiKeyCreds },
  balance: { schema: Spot, providers: [bybitBalance] },
});
