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

  it("只叠现货,滤掉 defi/perp(头寸不是持有代币)", () => {
    const items = tokenStackItems([
      b({ symbol: "ETH", usdValue: 100 }),
      b({ symbol: "aUSDC", usdValue: 500, kind: "defi" }), // DeFi 头寸 → 排除
      b({ symbol: "BTC", usdValue: 900, kind: "perp_position" }), // 永续仓位 → 排除
      b({ symbol: "USDC", usdValue: 300, kind: "perp_equity" }), // 永续权益 → 排除
    ]);
    expect(items.map((i) => i.name)).toEqual(["ETH"]);
  });

  it("过滤掉尘埃代币(无价/空投,< 尘埃阈值)", () => {
    const items = tokenStackItems([
      b({ symbol: "ETH", usdValue: 100 }),
      b({ symbol: "SPAM", usdValue: 0 }), // 无价 → 排除
      b({ symbol: "DUST", usdValue: 0.05 }), // < ZERO_DISPLAY_USD($0.10)→ 排除
    ]);
    expect(items.map((i) => i.name)).toEqual(["ETH"]);
  });

  it("同 symbol 多行合计过阈值则保留(逐行尘埃但合计非零)", () => {
    const items = tokenStackItems([
      b({ symbol: "ETH", usdValue: 0.06 }),
      b({ symbol: "eth", usdValue: 0.06 }), // 逐行 < $0.10,合计 0.12 ≥ $0.10 → 保留
    ]);
    expect(items.map((i) => i.name)).toEqual(["ETH"]);
  });

  it("纯 perp/defi 账户 → [](无现货可叠)", () => {
    expect(
      tokenStackItems([
        b({ symbol: "BTC", usdValue: 900, kind: "perp_position" }),
        b({ symbol: "aUSDC", usdValue: 500, kind: "defi" }),
      ]),
    ).toEqual([]);
  });

  it("空 → []", () => {
    expect(tokenStackItems([])).toEqual([]);
  });
});
