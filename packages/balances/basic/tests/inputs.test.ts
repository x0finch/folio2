import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CredentialValidationError,
  maskCredential,
  publicKeys,
  secretKeys,
  semiKeys,
  validateCredentials,
} from "../src/inputs";
import type { ProviderInput } from "../src/provider";

const EVM = /^0x[0-9a-fA-F]{40}$/;
const onchain: ProviderInput[] = [
  { key: "identifier", type: "public", label: "EVM Address", validator: z.string().regex(EVM) },
];
const okx: ProviderInput[] = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
  { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().trim().min(1) },
];

describe("public/semi/secret 分类", () => {
  it("splits by exposure level (identifier=public, apiKey=semi, secret/passphrase=secret)", () => {
    expect(publicKeys(onchain)).toEqual(["identifier"]);
    expect(semiKeys(onchain)).toEqual([]);
    expect(secretKeys(onchain)).toEqual([]);
    expect(publicKeys(okx)).toEqual([]);
    expect(semiKeys(okx)).toEqual(["apiKey"]);
    expect(secretKeys(okx)).toEqual(["secret", "passphrase"]);
  });
});

describe("maskCredential", () => {
  it("masks the middle, keeps a recognizable head/tail; deterministic", () => {
    expect(maskCredential("abcdefghijklmnop")).toBe("abcd…mnop"); // 长 → 首4尾4
    expect(maskCredential("abcdefgh")).toBe("ab…gh"); // 中等(7–11)→ 首2尾2
    expect(maskCredential("abcdef")).toBe("…"); // ≤6 → 不露真实字符
    expect(maskCredential("")).toBe(""); // 空 → 空
    expect(maskCredential("abcdefghijklmnop")).toBe(maskCredential("abcdefghijklmnop")); // 确定性
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
      { key: "apiKey", type: "semi", label: "API Key", validator: z.string().min(1) },
      { key: "secret", type: "secret", label: "API Secret", validator: z.string().min(1) },
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
