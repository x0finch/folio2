import { Defi, defineConnector, Spot } from "@folio/connectors-basic";
import { evmAccountCreds, zerionProvider } from "@folio/connectors-provider-zerion";
import { z } from "zod";

// evm connector manifest —— 组装契约(基座)+ provider(zerion)。manifest 组装归 entry;
// account.creds 声明随 provider(其天然消费者)落 provider 包,此处引入组合。
export const evm = defineConnector({
  id: "evm",
  label: "EVM",
  logo: "",
  account: { creds: evmAccountCreds },
  balance: {
    schema: z.discriminatedUnion("kind", [Spot, Defi]),
    providers: [zerionProvider],
  },
});
