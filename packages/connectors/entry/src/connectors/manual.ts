import { type CredField, Spot } from "@folio/connectors-basic";
import { z } from "zod";
import { defineConnector } from "../connector";

// Inline data URI (not proxied, since the proxy can't fetch data:). The viewBox frames the glyph's
// own bounding box so a circular avatar doesn't clip it. Fill is fixed, not currentColor: a data-URI
// image has no context to inherit from and would turn light under forced-colors.
const FEATHER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="-26 -38 324 324" fill="#222222"><path d="m211.84 134.81l-59.79 60.47a15.75 15.75 0 0 1-11.2 4.68H75.32l-29.66 29.7a8 8 0 0 1-11.32-11.32l22.59-22.58L124.7 128H209a4 4 0 0 1 2.84 6.81m4.86-104.24a64 64 0 0 0-85.9 4.14l-9.6 9.48A4 4 0 0 0 120 47v63l55-55a8 8 0 0 1 11.31 11.31L140.71 112h88.38a4 4 0 0 0 3.56-2.16a64.08 64.08 0 0 0-15.95-79.27M62.83 167.23L104 126.06v-55.3a4 4 0 0 0-6.81-2.84L60.69 104A15.9 15.9 0 0 0 56 115.31v49.09a4 4 0 0 0 6.83 2.83"/></svg>
`;

const MANUAL_LOGO = `data:image/svg+xml,${encodeURIComponent(FEATHER_SVG.replace(/\s+/g, " ").trim())}`;

// Only used at account creation; the app then writes the values into real tables. Declared as
// account creds so the generic create-account form drives it. Stored as a JSON string, hence the
// parse. `ticket` is the token picker's opaque token; the app decodes it, not the connector.
const manualFirstHolding = z.object({
  symbol: z.string().trim().min(1),
  unitPrice: z.coerce.number(),
  ticket: z.string().trim().min(1).optional(),
  amount: z.coerce.number(),
});

const manualAccountCreds = [
  {
    key: "tokens",
    type: "public",
    label: "Tokens",
    validator: z.preprocess((v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v; // let z.array reject it as a validation error instead of throwing
      }
    }, z.array(manualFirstHolding)),
  },
] as const satisfies readonly CredField[];

// No provider: manual holdings are computed by the app from its own tables and never synced. The
// connector still supplies the logo, the account form and the valuation mode.
export const manual = defineConnector({
  id: "manual",
  label: "Manual",
  logo: MANUAL_LOGO,
  account: { creds: manualAccountCreds },
  balance: { schema: Spot, providers: [] },
  valuation: "mark-to-market",
});
