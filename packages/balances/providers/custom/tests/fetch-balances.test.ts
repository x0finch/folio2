import type { FetchContext } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { customProvider, providers } from "../src";
import expected from "./fixtures/expected-balances.json";
import inputs from "./fixtures/inputs.json";

// 一个 manual 账户 = 一个手记资产;持仓走 ctx.creds(symbol/amount/unitPrice,P7.4.1)。
function ctx(creds: Record<string, unknown>): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "manual", label: "Manual" },
    creds,
    globalKeys: {},
  };
}

// manual provider 无外部 API,输入即 creds → 两份 fixture 一一对应(按 case 名连接,与其他 provider 同构):
// inputs.json(输入 creds 各例)→ expected-balances.json(解析后的期望 Balance[])。
// 覆盖:value=amount×unitPrice、price=unitPrice;identifier/fixed 在则透出 meta(不在则无 meta 键)。
describe("customProvider.fetchBalances (golden: fixtures in → fixture out)", () => {
  it.each(inputs)("$name", async ({ name, creds }) => {
    const balances = await customProvider.fetchBalances(ctx(creds));
    expect(balances).toEqual((expected as Record<string, unknown>)[name]);
  });

  it("serves accountType 'manual' and is exported in the providers array", () => {
    expect(customProvider.accountType).toBe("manual");
    expect(providers).toContain(customProvider);
  });
});
