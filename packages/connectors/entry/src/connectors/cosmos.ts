import { Spot } from "@folio/connectors-basic";
import { coinstatsBalance } from "@folio/upstreams";
import { defineConnector } from "../connector";
import { addressCreds } from "./address-creds";

const ATOM_LOGO = "https://assets.coingecko.com/coins/images/1481/large/cosmos_hub.png";

export const cosmos = defineConnector({
  id: "cosmos",
  label: "Cosmos",
  logo: ATOM_LOGO,
  account: { creds: addressCreds },
  balance: { schema: Spot, providers: [coinstatsBalance] },
});
