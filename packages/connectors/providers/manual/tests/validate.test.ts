import { publicKeys } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { manualAccountCreds, manualProvider } from "../src";

type Ctx = Parameters<typeof manualProvider.validateAccount>[0];

describe("custom account.creds / validateAccount", () => {
  it("declares symbol/amount/unitPrice/identifier as public account.creds", () => {
    expect(manualAccountCreds.map((i) => [i.key, i.type])).toEqual([
      ["symbol", "public"],
      ["amount", "public"],
      ["unitPrice", "public"],
      ["identifier", "public"],
    ]);
    expect(publicKeys(manualAccountCreds)).toEqual(["symbol", "amount", "unitPrice", "identifier"]);
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
