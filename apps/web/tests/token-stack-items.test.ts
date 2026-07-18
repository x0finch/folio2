import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "../src/lib/account-view";
import { tokenStackItems } from "../src/lib/token-stack-items";

const b = (
  p: Partial<OverviewBalance> & { symbol: string; usdValue: number },
): OverviewBalance => ({
  id: p.symbol,
  amount: 1,
  kind: "spot",
  metaJson: null,
  ...p,
});

describe("tokenStackItems", () => {
  it("按 symbol 去重(忽略大小写)并合计价值,保留首见的 symbol/logo", () => {
    const items = tokenStackItems([
      b({ symbol: "ETH", usdValue: 100, logo: "eth.png" }),
      b({ symbol: "eth", usdValue: 50 }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "ETH", logo: "eth.png", k: "ETH" });
  });

  it("按合计价值降序", () => {
    const items = tokenStackItems([
      b({ symbol: "A", usdValue: 10 }),
      b({ symbol: "B", usdValue: 100 }),
      b({ symbol: "C", usdValue: 50 }),
    ]);
    expect(items.map((i) => i.name)).toEqual(["B", "C", "A"]);
  });

  it("空 → []", () => {
    expect(tokenStackItems([])).toEqual([]);
  });
});
