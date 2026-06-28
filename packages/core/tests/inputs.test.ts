import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CredentialValidationError,
  publicKeys,
  secretKeys,
  validateCredentials,
} from "../src/inputs";
import type { ProviderInput } from "../src/provider";

const EVM = /^0x[0-9a-fA-F]{40}$/;
const onchain: ProviderInput[] = [
  { key: "identifier", type: "text", validator: z.string().regex(EVM) },
];
const okx: ProviderInput[] = [
  { key: "apiKey", type: "secret", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", validator: z.string().trim().min(1) },
  { key: "passphrase", type: "secret", validator: z.string().trim().min(1) },
];

describe("secretKeys / publicKeys", () => {
  it("splits by type (identifier is public, creds are secret)", () => {
    expect(publicKeys(onchain)).toEqual(["identifier"]);
    expect(secretKeys(onchain)).toEqual([]);
    expect(secretKeys(okx)).toEqual(["apiKey", "secret", "passphrase"]);
    expect(publicKeys(okx)).toEqual([]);
  });
});

describe("validateCredentials", () => {
  it("returns validated creds when every input passes", async () => {
    const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    expect(await validateCredentials(onchain, { identifier: addr })).toEqual({ identifier: addr });
    expect(await validateCredentials(okx, { apiKey: "a", secret: "b", passphrase: "c" })).toEqual({
      apiKey: "a",
      secret: "b",
      passphrase: "c",
    });
  });

  it("only includes declared input keys (ignores extras)", async () => {
    const binance: ProviderInput[] = [
      { key: "apiKey", type: "secret", validator: z.string().min(1) },
      { key: "secret", type: "secret", validator: z.string().min(1) },
    ];
    // passphrase 不在 inputs → 不校验、不带出(binance 无 passphrase)。
    expect(
      await validateCredentials(binance, { apiKey: "a", secret: "b", passphrase: "x" }),
    ).toEqual({
      apiKey: "a",
      secret: "b",
    });
  });

  it("throws CredentialValidationError on a bad value (EVM regex / missing passphrase)", async () => {
    await expect(validateCredentials(onchain, { identifier: "nope" })).rejects.toBeInstanceOf(
      CredentialValidationError,
    );
    await expect(
      validateCredentials(okx, { apiKey: "a", secret: "b", passphrase: "" }),
    ).rejects.toBeInstanceOf(CredentialValidationError);
  });
});
