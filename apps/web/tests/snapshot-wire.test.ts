import { describe, expect, it } from "vitest";
import { snapshotsFromWire } from "@/lib/core/snapshot-wire";

// 快照原料的浏览器解码(FOL-92):服务端发原样元组 + 未解析的 JSON,这里拼回页面要的形状。
describe("snapshotsFromWire", () => {
  const note = [{ title: "Pending", icon: "warning", content: [{ label: "x", value: 1 }] }];

  it("元组 → 每账户一张快照,余额行按账户归组,账户级 note 解析成 Note[]", () => {
    const out = snapshotsFromWire({
      snapshots: [
        ["a", 100, 30, JSON.stringify(note)],
        ["b", 200, 5, null],
      ],
      balances: [
        ["a", "b1", 2, 20, "spot", 10, "binance", "tk-btc", null],
        ["a", "b2", 1, 10, "defi", null, null, "tk-lp", '{"protocol":"x"}'],
      ],
    });
    expect(out).toEqual([
      {
        accountId: "a",
        takenAt: 100,
        totalUsd: 30,
        note,
        balances: [
          {
            id: "b1",
            amount: 2,
            usdValue: 20,
            kind: "spot",
            selfPrice: 10,
            platform: "binance",
            tokenId: "tk-btc",
            metaJson: null,
          },
          {
            id: "b2",
            amount: 1,
            usdValue: 10,
            kind: "defi",
            selfPrice: null,
            platform: null,
            tokenId: "tk-lp",
            metaJson: '{"protocol":"x"}',
          },
        ],
      },
      { accountId: "b", takenAt: 200, totalUsd: 5, note: undefined, balances: [] },
    ]);
  });

  it("坏 note(不是 JSON / 形状不对 / 空数组)→ 当作没有,不让整页打不开", () => {
    const out = snapshotsFromWire({
      snapshots: [
        ["a", 1, 1, "{not json"],
        ["b", 1, 1, JSON.stringify([{ nope: true }])],
        ["c", 1, 1, "[]"],
      ],
      balances: [],
    });
    expect(out.map((s) => s.note)).toEqual([undefined, undefined, undefined]);
  });
});
