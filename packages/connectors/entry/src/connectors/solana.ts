import { defineConnector, Spot } from "@folio/connectors-basic";
import { coinstatsAccountCreds, createCoinstatsProvider } from "./coinstats/provider";

const SOL_LOGO = "https://assets.coingecko.com/coins/images/4128/large/solana.png";

export const solana = defineConnector({
  id: "solana",
  label: "Solana",
  logo: SOL_LOGO,
  account: { creds: coinstatsAccountCreds },
  balance: { schema: Spot, providers: [createCoinstatsProvider("solana")] },
});
