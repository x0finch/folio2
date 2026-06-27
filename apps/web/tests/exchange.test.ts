import { decrypt, generateSecret } from "@folio/core";
import { describe, expect, it } from "vitest";
import { buildExchangeCredentials } from "../src/lib/exchange";

describe("buildExchangeCredentials", () => {
  it("encrypts apiKey+secret (no passphrase) — decrypt round-trip, ciphertext only", async () => {
    const key = generateSecret();
    const enc = await buildExchangeCredentials({ apiKey: "ak", secret: "sk" }, key);
    expect(JSON.parse(await decrypt(enc, key))).toEqual({ apiKey: "ak", secret: "sk" });
    expect(enc).not.toContain("ak");
    expect(enc).not.toContain("sk");
  });

  it("includes passphrase when provided (okx)", async () => {
    const key = generateSecret();
    const enc = await buildExchangeCredentials(
      { apiKey: "ak", secret: "sk", passphrase: "pp" },
      key,
    );
    expect(JSON.parse(await decrypt(enc, key))).toEqual({
      apiKey: "ak",
      secret: "sk",
      passphrase: "pp",
    });
  });
});
