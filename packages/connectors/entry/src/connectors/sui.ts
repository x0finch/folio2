import { Spot } from "@folio/connectors-basic";
import { coinstatsBalance } from "@folio/upstreams";
import { defineConnector } from "../connector";
import { addressCreds } from "./address-creds";

const SUI_LOGO = "https://assets.coingecko.com/coins/images/26375/large/sui-ocean-square.png";

export const sui = defineConnector({
  id: "sui",
  label: "Sui",
  logo: SUI_LOGO,
  account: { creds: addressCreds },
  balance: { schema: Spot, providers: [coinstatsBalance] },
});
