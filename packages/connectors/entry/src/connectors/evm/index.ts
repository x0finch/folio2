import { Defi, Spot } from "@folio/connectors-basic";
import { z } from "zod";
import { defineConnector } from "../../connector";
import { evmAccountCreds } from "./creds";
import { rabbyProvider } from "./rabby-provider";
import { zerionProvider } from "./zerion-provider";

// Order is priority: rabby is the default (no API key, two requests cover all chains); zerion is
// kept disabled as a fallback for runtime source selection.
const ETH_LOGO = "https://assets.coingecko.com/coins/images/279/large/ethereum.png";

export const evm = defineConnector({
  id: "evm",
  label: "EVM",
  logo: ETH_LOGO,
  account: { creds: evmAccountCreds },
  balance: {
    schema: z.discriminatedUnion("kind", [Spot, Defi]),
    providers: [rabbyProvider, zerionProvider],
  },
});
