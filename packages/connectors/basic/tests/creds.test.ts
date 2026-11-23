import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CredentialValidationError,
  type CredField,
  type CredsOf,
  maskCredential,
  publicKeys,
  secretKeys,
  semiKeys,
  validateCredentials,
} from "../src/creds";

const okxCreds = [
  { key: "apiKey", type: "semi", validator: z.string().min(1), label: "API Key" },
  { key: "secret", type: "secret", validator: z.string().min(1), label: "Secret" },
  { key: "passphrase", type: "secret", validator: z.string().min(1), label: "Passphrase" },
] as const satisfies readonly CredField[];

describe("validateCredentials", () => {
  it("returns validated values (with coercion) when all pass", async () => {
    const manual = [
      { key: "symbol", type: "public", validator: z.string(), label: "Symbol" },
      { key: "amount", type: "public", validator: z.coerce.number(), label: "Amount" },
    ] as const satisfies readonly CredField[];
    const out = await validateCredentials(manual, { symbol: "BTC", amount: "1.5" });
    expect(out).toEqual({ symbol: "BTC", amount: 1.5 });
  });

  it("throws CredentialValidationError naming the field when any fails", async () => {
    await expect(
      validateCredentials(okxCreds, { apiKey: "", secret: "s", passphrase: "p" }),
    ).rejects.toBeInstanceOf(CredentialValidationError);
    await expect(
      validateCredentials(okxCreds, { apiKey: "", secret: "s", passphrase: "p" }),
    ).rejects.toThrow(/apiKey/);
  });
});

describe("exposure classification + masking", () => {
  it("sorts keys into secret / semi / public", () => {
    expect(secretKeys(okxCreds)).toEqual(["secret", "passphrase"]);
    expect(semiKeys(okxCreds)).toEqual(["apiKey"]);
    expect(publicKeys(okxCreds)).toEqual([]);
  });

  it("maskCredential keeps the ends and hides the middle; short values are fully hidden", () => {
    expect(maskCredential("abcdefghijkl")).toBe("abcd…ijkl");
    expect(maskCredential("abc123")).toBe("…");
    expect(maskCredential("")).toBe("");
  });
});

describe("CredsOf inference", () => {
  it("infers the exact heterogeneous creds shape from a const literal", () => {
    type C = CredsOf<typeof okxCreds>;
    expectTypeOf<C>().toEqualTypeOf<{
      readonly apiKey: string;
      readonly secret: string;
      readonly passphrase: string;
    }>();
  });
});
