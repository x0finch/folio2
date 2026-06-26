import type { Account, AccountData, FetchContext } from "@folio/core";
import { describe, expect, it } from "vitest";
import { customProvider } from "../src";

function ctxWith(data: AccountData | undefined): FetchContext {
  const account: Account = { id: "a1", userId: "u1", type: "manual", label: "Manual", data };
  return { account, creds: {}, globalKeys: {} };
}

describe("customProvider.validate", () => {
  it("accepts well-formed holdings", async () => {
    const ctx = ctxWith({ holdings: [{ symbol: "BTC", amount: 0.5, usdValue: 32000 }] });
    expect(await customProvider.validate(ctx)).toBe(true);
  });

  it("rejects missing / empty holdings", async () => {
    expect(await customProvider.validate(ctxWith(undefined))).toBe(false);
    expect(await customProvider.validate(ctxWith({ holdings: [] }))).toBe(false);
  });

  it("rejects malformed holdings (empty symbol / non-finite numbers)", async () => {
    expect(
      await customProvider.validate(
        ctxWith({ holdings: [{ symbol: "", amount: 1, usdValue: 1 }] }),
      ),
    ).toBe(false);
    expect(
      await customProvider.validate(
        ctxWith({ holdings: [{ symbol: "BTC", amount: Number.NaN, usdValue: 1 }] }),
      ),
    ).toBe(false);
  });
});
