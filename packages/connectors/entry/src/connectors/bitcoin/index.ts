import { Spot } from "@folio/connectors-basic";
import { defineConnector } from "../../connector";
import { bitcoinAccountCreds, blockbookProvider } from "./provider";

const BTC_LOGO = "https://assets.coingecko.com/coins/images/1/large/bitcoin.png";

export const bitcoin = defineConnector({
  id: "bitcoin",
  label: "Bitcoin",
  logo: BTC_LOGO,
  account: { creds: bitcoinAccountCreds },
  balance: { schema: Spot, providers: [blockbookProvider] },
  // Emits confirmed amounts only (value 0); priced at market.
  valuation: "mark-to-market",
});
