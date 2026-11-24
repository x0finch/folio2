import { describe, expect, it } from "vitest";
import { snapshotsFromWire } from "@/lib/core/snapshot-wire";

describe("snapshotsFromWire", () => {
  const note = [{ title: "Pending", icon: "warning", content: [{ label: "x", value: 1 }] }];

  it("tuples: one snapshot per account, balance rows grouped by account, account-level note parsed into Note[]", () => {
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

  it("bad note (not JSON / wrong shape / empty array): treated as none, never breaks the whole page", () => {
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
