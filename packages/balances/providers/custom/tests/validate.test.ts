import type { FetchContext } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { customProvider } from "../src";

describe("customProvider.validateAccount", () => {
  it("true(无外部源;账户 creds 由 accountType 层 validator 校验过)", async () => {
    const ctx: FetchContext = {
      account: { id: "a", userId: "u", type: "manual", label: "M" },
      creds: {},
    };
    expect(await customProvider.validateAccount(ctx)).toBe(true);
  });
});
