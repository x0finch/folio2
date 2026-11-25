import { Spot } from "@folio/connectors-basic";
import { coinstatsBalance } from "@folio/upstreams";
import { defineConnector } from "../connector";
import { addressCreds } from "./address-creds";

const SOL_LOGO = "https://assets.coingecko.com/coins/images/4128/large/solana.png";

export const solana = defineConnector({
  id: "solana",
  label: "Solana",
  logo: SOL_LOGO,
  account: { creds: addressCreds },
  balance: { schema: Spot, providers: [coinstatsBalance] },
});
