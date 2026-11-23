import { defineConnector, Spot } from "@folio/connectors-basic";
import { coinstatsAccountCreds, createCoinstatsProvider } from "./coinstats/provider";

// CoinStats names this connection "sui-wallet", not "sui".
const SUI_LOGO = "https://assets.coingecko.com/coins/images/26375/large/sui-ocean-square.png";

export const sui = defineConnector({
  id: "sui",
  label: "Sui",
  logo: SUI_LOGO,
  account: { creds: coinstatsAccountCreds },
  balance: { schema: Spot, providers: [createCoinstatsProvider("sui-wallet")] },
});
