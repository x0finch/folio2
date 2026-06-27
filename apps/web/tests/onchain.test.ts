import { decrypt, generateSecret } from "@folio/core";
import { describe, expect, it } from "vitest";
import { buildEvmCredentials, EVM_ADDRESS_RE } from "../src/lib/onchain";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("EVM_ADDRESS_RE", () => {
  it("matches a valid 0x+40hex address", () => {
    expect(EVM_ADDRESS_RE.test(ADDR)).toBe(true);
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "nope", "0x123", `${ADDR}ff`, ADDR.replace("0x", "")]) {
      expect(EVM_ADDRESS_RE.test(bad)).toBe(false);
    }
  });
});

describe("buildEvmCredentials", () => {
  it("encrypts the address as { identifier } (decrypt round-trip)", async () => {
    const key = generateSecret();
    const enc = await buildEvmCredentials(ADDR, key);
    const creds = JSON.parse(await decrypt(enc, key));
    expect(creds).toEqual({ identifier: ADDR });
    expect(enc).not.toContain(ADDR); // ciphertext, not plaintext
  });
});
