import { publicKeys } from "@folio/connectors-basic";
import { describe, expect, it } from "vitest";
import { customProvider, manualAccountCreds } from "../src";

type Ctx = Parameters<typeof customProvider.validateAccount>[0];

describe("custom account.creds / validateAccount", () => {
  it("declares symbol/amount/unitPrice/identifier/fixed as public account.creds", () => {
    expect(manualAccountCreds.map((i) => [i.key, i.type])).toEqual([
      ["symbol", "public"],
      ["amount", "public"],
      ["unitPrice", "public"],
      ["identifier", "public"],
      ["fixed", "public"],
    ]);
    expect(publicKeys(manualAccountCreds)).toEqual([
      "symbol",
      "amount",
      "unitPrice",
      "identifier",
      "fixed",
    ]);
  });

  it("provider.creds is empty (no external source / provider key)", () => {
    expect(customProvider.creds).toEqual([]);
  });

  it("validateAccount is true (no external source; creds validated upstream by validateCredentials)", async () => {
    const ctx = {
      account: { id: "a", label: "M", connectorId: "manual", creds: {} },
      creds: {},
    } as unknown as Ctx;
    expect(await customProvider.validateAccount(ctx)).toBe(true);
  });
});
