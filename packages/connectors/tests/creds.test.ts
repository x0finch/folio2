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
  it("全过 → 返回已校验值(含 coerce)", async () => {
    const manual = [
      { key: "symbol", type: "public", validator: z.string(), label: "Symbol" },
      { key: "amount", type: "public", validator: z.coerce.number(), label: "Amount" },
    ] as const satisfies readonly CredField[];
    const out = await validateCredentials(manual, { symbol: "BTC", amount: "1.5" });
    expect(out).toEqual({ symbol: "BTC", amount: 1.5 }); // string "1.5" coerce 成 number
  });

  it("任一不过 → 抛 CredentialValidationError,消息带字段名", async () => {
    await expect(
      validateCredentials(okxCreds, { apiKey: "", secret: "s", passphrase: "p" }),
    ).rejects.toBeInstanceOf(CredentialValidationError);
    await expect(
      validateCredentials(okxCreds, { apiKey: "", secret: "s", passphrase: "p" }),
    ).rejects.toThrow(/apiKey/);
  });
});

describe("暴露级别分类 + 打码", () => {
  it("secret/semi/public keys 各归其类", () => {
    expect(secretKeys(okxCreds)).toEqual(["secret", "passphrase"]);
    expect(semiKeys(okxCreds)).toEqual(["apiKey"]);
    expect(publicKeys(okxCreds)).toEqual([]);
  });

  it("maskCredential 首尾留、中间省;过短全省", () => {
    expect(maskCredential("abcdefghijkl")).toBe("abcd…ijkl");
    expect(maskCredential("abc123")).toBe("…"); // ≤6 不露
    expect(maskCredential("")).toBe("");
  });
});

describe("CredsOf 类型推断", () => {
  it("从 const 字面量推出精确 creds 形状(异构)", () => {
    type C = CredsOf<typeof okxCreds>;
    expectTypeOf<C>().toEqualTypeOf<{
      readonly apiKey: string;
      readonly secret: string;
      readonly passphrase: string;
    }>();
  });
});
