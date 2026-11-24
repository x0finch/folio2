import type { CredField } from "@folio/connectors-basic";
import { z } from "zod";
import { EVM_ADDRESS_RE } from "./constants";

// Shared by both providers: it identifies the account, not a data source.
export const evmAccountCreds = [
  {
    key: "address",
    type: "public",
    validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
    label: "EVM Address",
    desc: "0x + 40 hex",
  },
] as const satisfies readonly CredField[];
