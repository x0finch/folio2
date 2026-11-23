import { describe, expect, it } from "vitest";
import type { HoldingSource } from "@/lib/core/portfolio";
import {
  groupByAccount,
  groupByPlatform,
} from "@/routes/_authed/-home/holdings/tokens/source-groups";

const src = (p: {
  platformId: string;
  platformName: string;
  logo?: string;
  accountId: string;
  accountLabel: string;
  amount: number;
  value: number;
}): HoldingSource => ({
  platform: { id: p.platformId, name: p.platformName, logo: p.logo },
  account: { id: p.accountId, label: p.accountLabel },
  amount: p.amount,
  value: p.value,
  kind: "spot",
});

const sources: HoldingSource[] = [
  src({
    platformId: "evm:42161",
    platformName: "Arbitrum",
    accountId: "w1",
    accountLabel: "im",
    amount: 19,
    value: 19,
  }),
  src({
    platformId: "evm:137",
    platformName: "Polygon",
    accountId: "w1",
    accountLabel: "im",
    amount: 0.07,
    value: 0.07,
  }),
  src({
    platformId: "evm:8453",
    platformName: "Base",
    accountId: "w1",
    accountLabel: "im",
    amount: 1,
    value: 1,
  }),
  src({
    platformId: "evm:42161",
    platformName: "Arbitrum",
    accountId: "cex1",
    accountLabel: "Binance",
    amount: 5,
    value: 5,
  }),
];

describe("groupByPlatform", () => {
  it("grouped by platform, value descending; single account gives single, several give count", () => {
    const gs = groupByPlatform(sources);
    expect(gs.map((g) => g.key)).toEqual(["evm:42161", "evm:8453", "evm:137"]);
    const arb = gs[0]!;
    expect(arb.amount).toBe(24); // 19 + 5
    expect(arb.value).toBe(24);
    expect(arb.count).toBe(2); // w1 + cex1
    expect(arb.single).toBeNull();
    const base = gs[1]!;
    expect(base.count).toBe(1);
    expect(base.single).toBe("im");
  });

  it("topAccounts sorted by in-group account value descending, with enough candidates for the fold threshold", () => {
    const many = [
      src({
        platformId: "p",
        platformName: "P",
        accountId: "a",
        accountLabel: "small",
        amount: 1,
        value: 1,
      }),
      src({
        platformId: "p",
        platformName: "P",
        accountId: "b",
        accountLabel: "big",
        amount: 9,
        value: 9,
      }),
      src({
        platformId: "p",
        platformName: "P",
        accountId: "c",
        accountLabel: "mid",
        amount: 5,
        value: 5,
      }),
      src({
        platformId: "p",
        platformName: "P",
        accountId: "a",
        accountLabel: "small",
        amount: 6,
        value: 6,
      }),
    ];
    const [g] = groupByPlatform(many);
    expect(g?.count).toBe(3);
    expect(g?.topAccounts.map((a) => a.label)).toEqual(["big", "small", "mid"]); // 9 > 7 > 5
  });

  it("single-account group: topAccounts is just that one", () => {
    const [g] = groupByPlatform([
      src({
        platformId: "p",
        platformName: "P",
        accountId: "a",
        accountLabel: "solo",
        amount: 1,
        value: 1,
      }),
    ]);
    expect(g?.topAccounts.map((a) => a.label)).toEqual(["solo"]);
    expect(g?.count).toBe(1);
  });
});

describe("groupByAccount", () => {
  it("grouped by account, value descending; single platform gives single, several give count + stacked avatars", () => {
    const gs = groupByAccount(sources);
    expect(gs.map((g) => g.key)).toEqual(["w1", "cex1"]);
    const w1 = gs[0]!;
    expect(w1.amount).toBe(20.07); // 19 + 0.07 + 1
    expect(w1.count).toBe(3);
    expect(w1.single).toBeNull();
    expect(w1.avatars).toHaveLength(3);
    expect(w1.avatars.map((a) => a.name)).toEqual(["Arbitrum", "Base", "Polygon"]);
    const cex = gs[1]!;
    expect(cex.count).toBe(1);
    expect(cex.single).toBe("Arbitrum");
  });
});
