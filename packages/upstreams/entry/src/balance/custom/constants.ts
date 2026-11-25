// Also the ref namer of rows with no chain, one per account kind like `manual`.
export const ID = "custom";

// The deployment's public origin; requests to it (or its subdomains) would loop back into the app.
export const OWN_ORIGIN = "BETTER_AUTH_URL";

// User-defined sources are unvetted: a few pages and a bounded body keep one account from eating a
// sync job's time and memory.
export const MAX_PAGES = 5;
export const MAX_BODY_BYTES = 1_000_000;

export const MAX_PATH_LENGTH = 512;
export const MAX_DOT_PATH_LENGTH = 128;
export const MAX_NAME_LENGTH = 64; // header and query parameter names
export const MAX_DECIMALS = 36;
export const MAX_SYMBOL_LENGTH = 32;
export const MAX_REF_PART_LENGTH = 128; // chain and contract values

// Names that only resolve inside a private network.
export const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "arpa"] as const;

// Headers the key may not ride in: they steer routing, sessions or proxies, not authentication.
export const FORBIDDEN_HEADERS = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
  "origin",
  "referer",
  "forwarded",
  "via",
  "x-real-ip",
  "accept",
  "user-agent",
]);
export const FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-", "cf-", "x-forwarded-"] as const;

export const ADDRESS_PLACEHOLDER = "{address}";
export const PAGE_PLACEHOLDER = "{page}";
