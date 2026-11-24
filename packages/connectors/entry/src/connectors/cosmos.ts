import { Spot } from "@folio/connectors-basic";
import { defineConnector } from "../connector";
import { coinstatsAccountCreds, createCoinstatsProvider } from "./coinstats/provider";

const ATOM_LOGO = "https://assets.coingecko.com/coins/images/1481/large/cosmos_hub.png";

export const cosmos = defineConnector({
  id: "cosmos",
  label: "Cosmos",
  logo: ATOM_LOGO,
  account: { creds: coinstatsAccountCreds },
  balance: { schema: Spot, providers: [createCoinstatsProvider("cosmos")] },
});
