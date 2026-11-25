import { SCRIPT_TYPES } from "@folio/bitcoin-derive";
import type { CredField } from "@folio/connectors-basic";
import { z } from "zod";
import { BTC_ADDRESS_RE, EXT_PUBKEY_FULL_RE } from "./constants";

export const bitcoinAccountCreds = [
  {
    key: "addressOrXpub",
    type: "public",
    label: "Bitcoin address or xpub",
    desc: "address (1…/3…/bc1…) or xpub/ypub/zpub",
    validator: z.string().refine((v) => BTC_ADDRESS_RE.test(v) || EXT_PUBKEY_FULL_RE.test(v), {
      message: "expected a BTC address or extended public key",
    }),
  },
  {
    key: "scriptType",
    type: "public",
    label: "Address type",
    validator: z.enum(SCRIPT_TYPES).optional(),
  },
] as const satisfies readonly CredField[];
