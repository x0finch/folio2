import { publicKeys, validateCredentials } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { manualAccountCreds, manualProvider } from "../src";

type Ctx = Parameters<typeof manualProvider.validateAccount>[0];

describe("custom account.creds / validateAccount", () => {
  it("declares a single public `tokens` account.creds field (multi-token holdings JSON)", () => {
    expect(manualAccountCreds.map((i) => [i.key, i.type])).toEqual([["tokens", "public"]]);
    expect(publicKeys(manualAccountCreds)).toEqual(["tokens"]);
  });

  it("provider.creds is empty (no external source / provider key)", () => {
    expect(manualProvider.creds).toEqual([]);
  });

  it("validateAccount is true (no external source; creds validated upstream by validateCredentials)", async () => {
    const ctx = {
      account: { id: "a", label: "M", connectorId: "manual", creds: {} },
      creds: {},
    } as unknown as Ctx;
    expect(await manualProvider.validateAccount(ctx)).toBe(true);
  });
});

// `tokens` 是 public JSON 字段:存库为字符串,同步/创建时经 validateCredentials 用本 validator
// 把 JSON 串 parse + coerce 成 typed 数组 [{symbol,unitPrice,identifier?,amount}]。
describe("tokens validator (JSON string → typed holdings array)", () => {
  it("parses a JSON string into a coerced holdings array", async () => {
    const out = await validateCredentials(manualAccountCreds, {
      tokens: JSON.stringify([
        { symbol: "BTC", unitPrice: "64000", amount: "0.5", identifier: "bitcoin" },
        { symbol: "FOO", unitPrice: 0.25, amount: 1000 },
      ]),
    });
    expect(out.tokens).toEqual([
      { symbol: "BTC", unitPrice: 64000, amount: 0.5, identifier: "bitcoin" },
      { symbol: "FOO", unitPrice: 0.25, amount: 1000 },
    ]);
  });

  it("accepts an empty holdings array (empty shell)", async () => {
    const out = await validateCredentials(manualAccountCreds, { tokens: "[]" });
    expect(out.tokens).toEqual([]);
  });

  it("rejects malformed JSON as a credential validation error (not a raw throw)", async () => {
    await expect(validateCredentials(manualAccountCreds, { tokens: "not json" })).rejects.toThrow(
      /tokens/,
    );
  });
});
