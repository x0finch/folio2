import { type FetchContext, publicKeys } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { customProvider } from "../src";

describe("customProvider inputs / validate", () => {
  it("declares symbol/amount/unitPrice/identifier/fixed as public inputs", () => {
    expect((customProvider.inputs ?? []).map((i) => [i.key, i.type])).toEqual([
      ["symbol", "public"],
      ["amount", "public"],
      ["unitPrice", "public"],
      ["identifier", "public"],
      ["fixed", "public"],
    ]);
    expect(publicKeys(customProvider.inputs ?? [])).toEqual([
      "symbol",
      "amount",
      "unitPrice",
      "identifier",
      "fixed",
    ]);
  });

  it("validate is true (no external source; creds validated upstream by validateCredentials)", async () => {
    const ctx: FetchContext = {
      account: { id: "a", userId: "u", type: "manual", label: "M" },
      creds: {},
      globalKeys: {},
    };
    expect(await customProvider.validate(ctx)).toBe(true);
  });
});
