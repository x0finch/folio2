import { formatTokenRef, normalizeNamer, parseTokenRef, type TokenRef } from "@folio/oracle-ref";

// A ticket is a tokenRef handed to the browser: an opaque base64url string, so the front end only carries it back and cannot
// learn the current upstream or its id shape (someone would `split("/")` and break on a source change).
// It is not encryption, a signature or authorisation: anyone can decode or forge one, so "this is a ticket we issued" is
// proven by content: its namer must be the current one, hence `decode` takes `namer` as a required parameter. Without the check, a
// hand-forged `<any>/issued:<any>` would turn a user-typed symbol into a trusted hint at mint (`hasTrustedSymbol(issued)`).
// Comparing the namer suffices; the four shapes each have a normal destination in mint. Only the account owner can forge one
// (same-origin CSRF guard) and the picker gives the same result legitimately, so this is no security hole: it keeps the
// server's guarantee from depending on a well-behaved client. A received ticket still goes through mint, which is per-user.
// base64url rather than base64: tickets go in URL query strings, where `+` and `/` would need escaping.

const B64URL = /^[A-Za-z0-9_-]+$/;

const toB64Url = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromB64Url = (s: string): string => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export const tokenTicket = {
  encode(ref: TokenRef): string {
    return toB64Url(ref);
  },

  // Undecodable / not a valid ref / namer not in `namer` gives undefined; the caller must handle it, since a ticket comes from the network.
  // `namer` may be a set: tickets are issued under more than one namer (the current upstream for crypto, `fiat` for fiat); a set
  // means "namer must be one of these". Another namer (`evil/issued:x`) is rejected so a forged ticket cannot make a typed symbol trusted.
  // Returns the canonical form (it goes straight into mint and `token_refs`, which hold canonical forms only).
  decode(ticket: string, namer: string | readonly string[]): TokenRef | undefined {
    if (!ticket || !B64URL.test(ticket)) return undefined;
    let raw: string;
    try {
      raw = fromB64Url(ticket);
    } catch {
      return undefined;
    }
    const parsed = parseTokenRef(raw);
    if (parsed.kind === "unknown") return undefined;
    // Namers are compared in canonical form, not by raw string case.
    const allowed = (typeof namer === "string" ? [namer] : namer).map(normalizeNamer);
    if (!allowed.includes(parsed.namer)) return undefined;
    return formatTokenRef(parsed);
  },
};
