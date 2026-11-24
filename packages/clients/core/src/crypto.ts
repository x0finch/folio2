import { Effect } from "effect";
import { SigningFailure, summaryOf } from "./errors";

// Duplicated from `@folio/connectors-basic` on purpose: clients must not depend on the connector
// contract package.

const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function hmacSha256(
  secret: string,
  message: string,
  encoding: "hex" | "base64",
): Effect.Effect<string, SigningFailure> {
  return Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
      );
      return encoding === "hex" ? bytesToHex(sig) : bytesToBase64(sig);
    },
    // The WebCrypto error never contains the key.
    catch: (cause) => new SigningFailure({ where: "hmac-sha256", cause: summaryOf(cause) }),
  });
}
