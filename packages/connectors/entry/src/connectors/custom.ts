import { type CredField, Spot } from "@folio/connectors-basic";
import { customBalance, decodeCustomConfig } from "@folio/upstreams";
import { z } from "zod";
import { defineConnector } from "../connector";

// Inline data URI like manual's: a user-defined source has no logo of its own to proxy.
const PLUG_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24" fill="none" stroke="#222222" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>
`;

const CUSTOM_LOGO = `data:image/svg+xml,${encodeURIComponent(PLUG_SVG.replace(/\s+/g, " ").trim())}`;

const needsKey = (raw: string | undefined): boolean => {
  const decoded = decodeCustomConfig(raw);
  return decoded.ok && decoded.config.auth !== undefined && decoded.config.auth !== "none";
};

const hostOf = (raw: string | undefined): string | undefined => {
  const decoded = decodeCustomConfig(raw);
  return decoded.ok ? decoded.config.host : undefined;
};

const customAccountCreds = [
  {
    key: "config",
    type: "public",
    label: "Source config",
    desc: "JSON: host, path, auth, pagination, rows, fields",
    validator: z.string().transform((raw, ctx) => {
      const decoded = decodeCustomConfig(raw);
      if (decoded.ok) return decoded.config;
      ctx.addIssue({ code: "custom", message: decoded.message });
      return z.NEVER;
    }),
  },
  {
    key: "address",
    type: "public",
    label: "Wallet Address",
    validator: z.string().trim().min(1).optional(),
  },
  {
    key: "apiKey",
    type: "secret",
    label: "API Key",
    validator: z.string().trim().min(1).optional(),
  },
] as const satisfies readonly CredField[];

// A source the user describes; mark-to-market, so its own prices value only coins the market can't, and the key
// is dropped once the config points at another host.
export const custom = defineConnector({
  id: "custom",
  label: "Custom source",
  logo: CUSTOM_LOGO,
  account: {
    creds: customAccountCreds,
    keepsSecrets: (previous, next) => {
      const host = hostOf(previous.config);
      return host !== undefined && host === hostOf(next.config);
    },
    // `apiKey` is optional per field; a keyed config makes it required.
    needs: (publicCreds) => (needsKey(publicCreds.config) ? ["apiKey"] : []),
  },
  balance: { schema: Spot, providers: [customBalance] },
  valuation: "mark-to-market",
});
