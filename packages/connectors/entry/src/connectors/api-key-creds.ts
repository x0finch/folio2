import type { CredField } from "@folio/connectors-basic";
import { z } from "zod";

// A CEX read-only API key: the key is an identifier sent in plain headers (semi); the secret signs.
export const apiKeyCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];
