import { describe, expect, it } from "vitest";
import type { HoldingSource } from "../src/lib/core/aggregate";
import {
  groupByAccount,
  groupByPlatform,
} from "../src/routes/_authed/-home/holdings/tokens/source-groups";

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

// 同一账户 "im" 在三条链上持有,外加一个交易所账户在其中一条链。
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
  it("按平台聚合,value 降序;单账户给 single、多账户给 count", () => {
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

  // #351 ③:平台行副名点名「组内最大的几个账户」,故 topAccounts 得按**账户在组内的 value** 排序,
  // 不是出现顺序、也不是账户总资产。真正的折叠由组件按 count 走 collapseToSlots,这里只保证
  // 「带够候选 + 顺序正确」。
  it("topAccounts 按组内账户 value 倒序,带足折叠阈值个候选", () => {
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
      // 同一账户在同平台的第二笔:应累加到 a 上(1 + 6 = 7 → 越过 mid,升到第二)
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

  it("单账户组:topAccounts 就那一个", () => {
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
  it("按账户聚合,value 降序;单平台给 single、多平台给 count + 叠标 avatars", () => {
    const gs = groupByAccount(sources);
    expect(gs.map((g) => g.key)).toEqual(["w1", "cex1"]);
    const w1 = gs[0]!;
    expect(w1.amount).toBe(20.07); // 19 + 0.07 + 1
    expect(w1.count).toBe(3); // 三条链
    expect(w1.single).toBeNull();
    expect(w1.avatars).toHaveLength(3);
    // **头像按组内金额降序**(#133 收尾,与账户行叠标同一条规则)。以前是「哪条 source 先来」的
    // 顺序,也就是没有顺序。Arbitrum 19 > Base 1 > Polygon 0.07。
    expect(w1.avatars.map((a) => a.name)).toEqual(["Arbitrum", "Base", "Polygon"]);
    // 只排不砍:Polygon 那 $0.07 低于展示阈值,但砍掉它头像就只剩 2 个、与上面那句 count=3 对不上。
    const cex = gs[1]!;
    expect(cex.count).toBe(1);
    expect(cex.single).toBe("Arbitrum");
  });
});
