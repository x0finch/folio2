import { describe, expect, it } from "vitest";
import type { HoldingSource } from "../src/lib/aggregate";
import { groupByAccount, groupByPlatform } from "../src/lib/source-groups";

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
  isMargin: false,
});

// 同一账户 "im" 在三条链上持有,外加一个交易所账户在其中一条链。
const sources: HoldingSource[] = [
  src({
    platformId: "eip155:42161",
    platformName: "Arbitrum",
    accountId: "w1",
    accountLabel: "im",
    amount: 19,
    value: 19,
  }),
  src({
    platformId: "eip155:137",
    platformName: "Polygon",
    accountId: "w1",
    accountLabel: "im",
    amount: 0.07,
    value: 0.07,
  }),
  src({
    platformId: "eip155:8453",
    platformName: "Base",
    accountId: "w1",
    accountLabel: "im",
    amount: 1,
    value: 1,
  }),
  src({
    platformId: "eip155:42161",
    platformName: "Arbitrum",
    accountId: "cex1",
    accountLabel: "Binance",
    amount: 5,
    value: 5,
  }),
];

describe("groupByPlatform", () => {
  it("按平台聚合,value 降序;单账户给 single、多账户给 count", () => {
    const gs = groupByPlatform(sources);
    expect(gs.map((g) => g.key)).toEqual(["eip155:42161", "eip155:8453", "eip155:137"]);
    const arb = gs[0]!;
    expect(arb.amount).toBe(24); // 19 + 5
    expect(arb.value).toBe(24);
    expect(arb.count).toBe(2); // w1 + cex1
    expect(arb.single).toBeNull();
    const base = gs[1]!;
    expect(base.count).toBe(1);
    expect(base.single).toBe("im");
  });
});

describe("groupByAccount", () => {
  it("按账户聚合,value 降序;单平台给 single、多平台给 count + 叠标 avatars", () => {
    const gs = groupByAccount(sources);
    expect(gs.map((g) => g.key)).toEqual(["w1", "cex1"]);
    const w1 = gs[0]!;
    expect(w1.amount).toBe(20.07); // 19 + 0.07 + 1
    expect(w1.count).toBe(3); // 三条链
    expect(w1.single).toBeNull();
    expect(w1.avatars).toHaveLength(3);
    const cex = gs[1]!;
    expect(cex.count).toBe(1);
    expect(cex.single).toBe("Arbitrum");
  });
});
