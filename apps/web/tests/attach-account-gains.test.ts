import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import { attachAccountHoldingGains, type PrevSlice } from "@/lib/core/portfolio";

// 账户抽屉逐币盈亏(ADR 0050,两端相减)。回归(code-review 修 #3):现值侧必须与起点侧**同口径**
// —— 只 isFungible 现货、有 token_id 的行进「按币」聚合。少了这个过滤,同一 token_id 又有现货又有
// DeFi/perp 行时,现值会把 DeFi 那份也算进来 → 现货行盈亏虚高。

const LIDO = JSON.stringify({ protocol: "Lido", positionType: "staked" });

// 起点组的一行(OverviewBalance;viewKind 只读 kind/metaJson)。
const pb = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: crypto.randomUUID(),
  symbol: "S",
  amount: 1,
  usdValue: 0,
  kind: "spot",
  tokenId: "shared",
  metaJson: null,
  ...over,
});

const prevOf = (accountId: string, balances: OverviewBalance[]): ReadonlyMap<string, PrevSlice> =>
  new Map([[accountId, { snapshot: { takenAt: 0 }, balances }]]);

describe("attachAccountHoldingGains —— 两端同口径", () => {
  it("同一 token_id 又有现货又有 DeFi 行 → 现货行盈亏只按现货两端算,不被 DeFi 虚高", () => {
    const row = {
      account: { id: "a" },
      archivedAt: null,
      totalUsd: 610, // 现货 110 + DeFi 500
      balances: [
        { id: "spot", tokenId: "shared", amount: 1, usdValue: 110, kind: "spot" },
        { id: "defi", tokenId: "shared", amount: 1, usdValue: 500, kind: "defi", metaJson: LIDO },
      ],
    };
    const prev = prevOf("a", [
      pb({ tokenId: "shared", usdValue: 100, kind: "spot" }),
      pb({ tokenId: "shared", usdValue: 480, kind: "defi", metaJson: LIDO }),
    ]);

    const [out] = attachAccountHoldingGains([row], prev);

    // 账户级:全部余额两端相减 610 − 580 = +30。
    expect(out!.gain24h?.amount).toBeCloseTo(30, 6);
    // 现货行:起点 100(只现货)→ 现值 110(只现货,DeFi 那 500 不算进)→ +10。
    const spot = out!.balances.find((b) => b.id === "spot");
    expect(spot?.gain24h?.amount).toBeCloseTo(10, 6);
    expect(spot?.gain24h?.pct).toBeCloseTo(10, 6);
    // 没修之前:现值会被算成 110+500=610,+510 摊到现货行 ≈ +91.8。钉住它不再发生。
    expect(spot?.gain24h?.amount).not.toBeCloseTo(91.8, 1);
    // DeFi 行不是现货 → 逐行盈亏字段省略(它的盈亏由 DeFi 分区给)。
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });

  it("起点缺(不满 24h / 断线)→ 现货行 null、非现货行 undefined", () => {
    const row = {
      account: { id: "a" },
      archivedAt: null,
      totalUsd: 110,
      balances: [
        { id: "spot", tokenId: "shared", amount: 1, usdValue: 110, kind: "spot" },
        { id: "defi", tokenId: "shared", amount: 1, usdValue: 500, kind: "defi", metaJson: LIDO },
      ],
    };
    const [out] = attachAccountHoldingGains([row], new Map());
    expect(out!.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "spot")?.gain24h).toBeNull();
    expect(out!.balances.find((b) => b.id === "defi")?.gain24h).toBeUndefined();
  });
});
