import { decrypt, generateSecret } from "@folio/core";
import { describe, expect, it } from "vitest";
import { buildEvmCredentials, normalizeEvmAddress } from "../src/lib/onchain";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("normalizeEvmAddress", () => {
  it("accepts and trims a valid 0x+40hex address", () => {
    expect(normalizeEvmAddress(`  ${ADDR}  `)).toBe(ADDR);
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "nope", "0x123", `${ADDR}ff`, ADDR.replace("0x", "")]) {
      expect(() => normalizeEvmAddress(bad)).toThrow(/invalid EVM address/);
    }
  });
});

describe("buildEvmCredentials", () => {
  it("encrypts the address as { identifier } (decrypt round-trip)", async () => {
    const key = generateSecret();
    const enc = await buildEvmCredentials(ADDR, key);
    const creds = JSON.parse(await decrypt(enc, key));
    expect(creds).toEqual({ identifier: ADDR });
    // no holdings / dataJson concerns here — onchain creds are secrets only
    expect(enc).not.toContain(ADDR); // ciphertext, not plaintext
  });
});
