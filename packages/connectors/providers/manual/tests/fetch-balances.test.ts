import { describe, expect, it } from "vitest";
import { manualProvider } from "../src";
import expected from "./fixtures/expected-balances.json";
import inputs from "./fixtures/inputs.json";

// 新 FetchContext 形状:account.creds(AC:单个 tokens 数组 [{symbol,unitPrice,identifier?,amount}],ADR 0017)+ creds(PC:空)。
type Ctx = Parameters<typeof manualProvider.fetchBalances>[0];
function ctx(creds: Record<string, unknown>): Ctx {
  return {
    account: { id: "a1", label: "Manual", connectorId: "manual", creds },
    creds: {},
  } as unknown as Ctx;
}

// manual provider 无外部 API,输入即 account.creds → 两份 fixture 一一对应(按 case 名连接,与其他 provider 同构):
// inputs.json(输入 creds 各例)→ expected-balances.json(解析后的期望 Spot[])。
// 覆盖:kind:"spot"、value=amount×unitPrice、price=unitPrice;identifier 在则透出 tokenKey(不在则无该键)。
describe("manualProvider.fetchBalances (golden: fixtures in → fixture out)", () => {
  it.each(inputs)("$name", async ({ name, creds }) => {
    const { balances } = await manualProvider.fetchBalances(ctx(creds));
    expect(balances).toEqual((expected as Record<string, unknown>)[name]);
  });

  it("has provider id 'manual' and label 'Manual'", () => {
    expect(manualProvider.id).toBe("manual");
    expect(manualProvider.label).toBe("Manual");
  });
});
