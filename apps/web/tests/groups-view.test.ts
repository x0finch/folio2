import { describe, expect, it } from "vitest";
import {
  type AccountTotal,
  type GroupInfo,
  type MembershipInfo,
  toGroupedView,
} from "../src/lib/groups-view";

const acc = (id: string, label: string, totalUsd: number): AccountTotal => ({
  account: { id, label },
  totalUsd,
});
const g = (id: string, name: string, sortOrder = 0): GroupInfo => ({ id, name, sortOrder });
const m = (accountId: string, groupId: string): MembershipInfo => ({ accountId, groupId });

describe("toGroupedView", () => {
  it("counts a multi-group account in every group subtotal (no dedup at group level)", () => {
    const rows = [acc("a1", "A1", 100), acc("a2", "A2", 50)];
    const groups = [g("g1", "Core"), g("g2", "Watch")];
    // a1 在 g1 和 g2;a2 只在 g1
    const memberships = [m("a1", "g1"), m("a1", "g2"), m("a2", "g1")];

    const v = toGroupedView(rows, groups, memberships);
    const core = v.groups.find((s) => s.group.id === "g1");
    const watch = v.groups.find((s) => s.group.id === "g2");
    expect(core?.subtotalUsd).toBe(150); // a1 + a2
    expect(watch?.subtotalUsd).toBe(100); // a1 only
    expect(core?.accounts.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    // grand total != Σ subtotals(150+100=250),实际去重应为 150 —— 由调用方用 overview.totalUsd
    expect(core!.subtotalUsd + watch!.subtotalUsd).not.toBe(150);
  });

  it("puts accounts in no group under ungrouped", () => {
    const rows = [acc("a1", "A1", 100), acc("a2", "A2", 50)];
    const v = toGroupedView(rows, [g("g1", "Core")], [m("a1", "g1")]);
    expect(v.groups[0].accounts.map((a) => a.id)).toEqual(["a1"]);
    expect(v.ungrouped.accounts.map((a) => a.id)).toEqual(["a2"]);
    expect(v.ungrouped.subtotalUsd).toBe(50);
  });

  it("orders groups by sortOrder then name; empty group has 0 subtotal", () => {
    const rows = [acc("a1", "A1", 10)];
    const groups = [g("g2", "Zeta", 1), g("g1", "Alpha", 0), g("g3", "Beta", 0)];
    const v = toGroupedView(rows, groups, [m("a1", "g3")]);
    expect(v.groups.map((s) => s.group.name)).toEqual(["Alpha", "Beta", "Zeta"]);
    expect(v.groups.find((s) => s.group.id === "g1")?.subtotalUsd).toBe(0); // empty
  });

  it("handles no groups / no accounts", () => {
    expect(toGroupedView([], [], [])).toEqual({
      groups: [],
      ungrouped: { subtotalUsd: 0, accounts: [] },
    });
    const v = toGroupedView([acc("a1", "A1", 100)], [], []);
    expect(v.groups).toEqual([]);
    expect(v.ungrouped.accounts).toHaveLength(1);
  });
});
