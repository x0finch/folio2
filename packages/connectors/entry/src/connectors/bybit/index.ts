import { Spot } from "@folio/connectors-basic";
import { defineConnector } from "../../connector";
import { bybitAccountCreds, bybitProvider } from "./provider";

const BYBIT_LOGO = "https://assets.coingecko.com/markets/images/698/large/bybit_spot.png";

export const bybit = defineConnector({
  id: "bybit",
  label: "Bybit",
  logo: BYBIT_LOGO,
  account: { creds: bybitAccountCreds },
  balance: { schema: Spot, providers: [bybitProvider] },
});
