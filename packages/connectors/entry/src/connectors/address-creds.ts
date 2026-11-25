import type { CredField } from "@folio/connectors-basic";
import { z } from "zod";

// Only non-empty: address formats differ per chain, so the upstream is the judge.
export const addressCreds = [
  { key: "address", type: "public", label: "Wallet Address", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];
