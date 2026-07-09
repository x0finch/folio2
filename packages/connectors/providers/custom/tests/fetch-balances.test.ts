import { describe, expect, it } from "vitest";
import { customProvider } from "../src";
import expected from "./fixtures/expected-balances.json";
import inputs from "./fixtures/inputs.json";

// 新 FetchContext 形状:account.creds(AC:symbol/amount/unitPrice + 可选 identifier/fixed,P7.4.1)+ creds(PC:空)。
type Ctx = Parameters<typeof customProvider.fetchBalances>[0];
function ctx(creds: Record<string, unknown>): Ctx {
  return {
    account: { id: "a1", label: "Manual", connectorId: "manual", creds },
    creds: {},
  } as unknown as Ctx;
}

// manual provider 无外部 API,输入即 account.creds → 两份 fixture 一一对应(按 case 名连接,与其他 provider 同构):
// inputs.json(输入 creds 各例)→ expected-balances.json(解析后的期望 Spot[])。
// 覆盖:kind:"spot"、value=amount×unitPrice、price=unitPrice;identifier/fixed 在则透出 tokenKey/meta(不在则无该键)。
describe("customProvider.fetchBalances (golden: fixtures in → fixture out)", () => {
  it.each(inputs)("$name", async ({ name, creds }) => {
    const balances = await customProvider.fetchBalances(ctx(creds));
    expect(balances).toEqual((expected as Record<string, unknown>)[name]);
  });

  it("has connector-facing id 'custom' and label 'Manual'", () => {
    expect(customProvider.id).toBe("custom");
    expect(customProvider.label).toBe("Manual");
  });
});
