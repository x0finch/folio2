import { defineConnector, Spot } from "@folio/connectors-basic";
import { okxAccountCreds, okxProvider } from "./provider";

const OKX_LOGO =
  "https://assets.coingecko.com/markets/images/96/large/WeChat_Image_20220117220452.png";

export const okx = defineConnector({
  id: "okx",
  label: "OKX",
  logo: OKX_LOGO,
  account: { creds: okxAccountCreds },
  balance: { schema: Spot, providers: [okxProvider] },
});
