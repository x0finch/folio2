import { Spot } from "@folio/connectors-basic";
import { okxBalance } from "@folio/upstreams";
import { z } from "zod";
import { defineConnector } from "../connector";
import { apiKeyCreds } from "./api-key-creds";

const OKX_LOGO =
  "https://assets.coingecko.com/markets/images/96/large/WeChat_Image_20220117220452.png";

export const okx = defineConnector({
  id: "okx",
  label: "OKX",
  logo: OKX_LOGO,
  account: {
    creds: [
      ...apiKeyCreds,
      {
        key: "passphrase",
        type: "secret",
        label: "Passphrase",
        validator: z.string().trim().min(1),
      },
    ],
  },
  balance: { schema: Spot, providers: [okxBalance] },
});
