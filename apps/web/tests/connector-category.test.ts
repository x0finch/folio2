import { describe, expect, it } from "vitest";
import { accountCategory, TYPE_GROUPS } from "../src/lib/account-types";
import { CONNECTOR_CATEGORY, categoryOf } from "../src/lib/connector-category";

// 分类单一事实源:aggregate 平台键归类与 add-account 分组皆从 CONNECTOR_CATEGORY 派生。
describe("connector-category(单一事实源)", () => {
  it("categoryOf 归类正确;未知 connectorId → undefined(兜底按链上)", () => {
    expect(categoryOf("binance")).toBe("exchange");
    expect(categoryOf("hyperliquid")).toBe("perp");
    expect(categoryOf("manual")).toBe("manual");
    expect(categoryOf("evm")).toBe("onchain");
    expect(categoryOf("bitcoin")).toBe("onchain");
    expect(categoryOf("kraken")).toBeUndefined(); // 未接线 → 兜底
  });

  it("覆盖全部 9 个已上线 connector(穷举 Record;新增不填即编译报错)", () => {
    expect(Object.keys(CONNECTOR_CATEGORY).sort()).toEqual(
      [
        "binance",
        "bitcoin",
        "cosmos",
        "evm",
        "hyperliquid",
        "manual",
        "okx",
        "solana",
        "sui",
      ].sort(),
    );
  });

  it("account-types.TYPE_GROUPS 从同表派生:类别顺序 + 组内成员正确", () => {
    expect(TYPE_GROUPS).toEqual([
      { category: "manual", types: ["manual"] },
      { category: "onchain", types: ["evm", "bitcoin", "solana", "sui", "cosmos"] },
      { category: "exchange", types: ["binance", "okx"] },
      { category: "perp", types: ["hyperliquid"] },
    ]);
  });

  it("accountCategory 与 categoryOf 同源", () => {
    expect(accountCategory("okx")).toBe("exchange");
    expect(accountCategory("sui")).toBe("onchain");
  });
});
