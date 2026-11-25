import { type CredField, Spot } from "@folio/connectors-basic";
import { configNeeds, customBalance, decodeCustomConfig } from "@folio/upstreams";
import { z } from "zod";
import { defineConnector } from "../connector";

// Inline data URI like manual's: a user-defined source has no logo of its own to proxy.
const PLUG_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24" fill="none" stroke="#222222" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>
`;

const CUSTOM_LOGO = `data:image/svg+xml,${encodeURIComponent(PLUG_SVG.replace(/\s+/g, " ").trim())}`;

const needsOf = (raw: string | undefined) => {
  const decoded = decodeCustomConfig(raw);
  return decoded.ok ? configNeeds(decoded.config) : { key: false, address: false };
};

const authOf = (raw: string | undefined) => {
  const decoded = decodeCustomConfig(raw);
  return decoded.ok ? (decoded.config.auth ?? "none") : undefined;
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
    // No `.`: use-intl reads one as a nested message key.
    desc: "JSON: host, path, query, auth, pagination, rows, fields — never a key here, it goes in API Key",
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
    // Only dots would be read as a path segment once filled into the URL.
    validator: z
      .string()
      .trim()
      .min(1)
      .refine((v) => !/^\.+$/.test(v), "not only dots")
      .optional(),
  },
  {
    key: "apiKey",
    type: "secret",
    label: "API Key",
    // Visible ASCII only: anything else can't travel in a header.
    validator: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]+$/, "only visible ASCII characters, no spaces")
      .optional(),
  },
] as const satisfies readonly CredField[];

// A source the user describes; mark-to-market, so its own prices value only coins the market can't, and the key
// is dropped once the config points at another host or stops sending one.
export const custom = defineConnector({
  id: "custom",
  label: "Custom source",
  logo: CUSTOM_LOGO,
  account: {
    creds: customAccountCreds,
    keepsSecrets: (previous, next) => {
      // A keyless config drops the key too, or nothing would ever clear it.
      const host = hostOf(previous.config);
      // The key stays only where the user put it: same host, same placement (a header key moved
      // into the query would start showing up in URLs).
      return (
        host !== undefined &&
        host === hostOf(next.config) &&
        needsOf(next.config).key &&
        JSON.stringify(authOf(previous.config)) === JSON.stringify(authOf(next.config))
      );
    },
    // `apiKey` and `address` are optional per field; the config can make either required.
    needs: (publicCreds) => {
      const { key, address } = needsOf(publicCreds.config);
      return [...(key ? ["apiKey"] : []), ...(address ? ["address"] : [])];
    },
  },
  balance: { schema: Spot, providers: [customBalance] },
  valuation: "mark-to-market",
});
