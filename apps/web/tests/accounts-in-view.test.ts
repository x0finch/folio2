import { describe, expect, it } from "vitest";
import {
  accountIdsInView,
  accountsInView,
  accountsMatchingPin,
  pinsInView,
  type TabPin,
  toTabPin,
} from "@/lib/core/accounts-in-view";

// Active accounts in the selected portfolio; unassigned accounts fall back into the default view.

const acc = (id: string, archivedAt: number | null = null) => ({ id, archivedAt });
const DEFAULT = "pf-default";
const WATCH = "pf-watch";

describe("accountsInView", () => {
  it("returns only accounts in the selected portfolio", () => {
    const accounts = [acc("a"), acc("b"), acc("c")];
    const memberships = [
      { accountId: "a", portfolioId: DEFAULT },
      { accountId: "b", portfolioId: WATCH },
      { accountId: "c", portfolioId: DEFAULT },
    ];
    expect(accountsInView(accounts, memberships, DEFAULT, DEFAULT).map((a) => a.id)).toEqual([
      "a",
      "c",
    ]);
    expect(accountsInView(accounts, memberships, WATCH, DEFAULT).map((a) => a.id)).toEqual(["b"]);
  });

  it("excludes archived accounts (orthogonal to portfolio membership)", () => {
    const accounts = [acc("a"), acc("b", 123)];
    const memberships = [
      { accountId: "a", portfolioId: DEFAULT },
      { accountId: "b", portfolioId: DEFAULT },
    ];
    expect(accountsInView(accounts, memberships, DEFAULT, DEFAULT).map((a) => a.id)).toEqual(["a"]);
  });

  it("unassigned accounts fall back into the default view (money never disappears)", () => {
    const accounts = [acc("a"), acc("orphan")];
    const memberships = [{ accountId: "a", portfolioId: DEFAULT }];
    // Default view: orphan is included.
    expect(accountsInView(accounts, memberships, DEFAULT, DEFAULT).map((a) => a.id)).toEqual([
      "a",
      "orphan",
    ]);
    // Non-default view: no fallback.
    expect(accountsInView(accounts, memberships, WATCH, DEFAULT)).toEqual([]);
  });

  it("no memberships + default view → all active accounts (backward compatible)", () => {
    const accounts = [acc("a"), acc("b"), acc("c", 999)];
    expect(accountsInView(accounts, [], DEFAULT, DEFAULT).map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("accountIdsInView", () => {
  const memberships = [
    { accountId: "a", portfolioId: DEFAULT },
    { accountId: "b", portfolioId: WATCH },
    { accountId: "arch", portfolioId: WATCH },
  ];

  it("ignores archiving: every member id is included (archived members feed past chart points)", () => {
    const set = accountIdsInView(["a", "b", "arch"], memberships, WATCH, DEFAULT);
    expect([...set].sort()).toEqual(["arch", "b"]);
  });

  it("unassigned ids fall back into the default set, not into others", () => {
    const ids = ["a", "b", "orphan"];
    expect(accountIdsInView(ids, memberships, DEFAULT, DEFAULT).has("orphan")).toBe(true);
    expect(accountIdsInView(ids, memberships, WATCH, DEFAULT).has("orphan")).toBe(false);
  });
});

// Custom tab pins narrow the set already filtered by portfolio.
describe("accountsMatchingPin", () => {
  const accs = [
    { id: "a", connectorId: "binance" },
    { id: "b", connectorId: "okx" },
    { id: "c", connectorId: "binance" },
  ];
  const tagLinks = [
    { accountId: "a", tagId: "t-long" },
    { accountId: "c", tagId: "t-long" },
    { accountId: "b", tagId: "t-farm" },
  ];

  it("pin=null → returned as-is (default view not narrowed)", () => {
    expect(accountsMatchingPin(accs, null, tagLinks)).toEqual(accs);
  });

  it("connector pin → only that connector's accounts", () => {
    const pin: TabPin = { kind: "connector", connectorId: "binance" };
    expect(accountsMatchingPin(accs, pin, tagLinks).map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("tag pin → only accounts with that tag", () => {
    const pin: TabPin = { kind: "tag", tagId: "t-long" };
    expect(accountsMatchingPin(accs, pin, tagLinks).map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("tag pin with no match → empty", () => {
    const pin: TabPin = { kind: "tag", tagId: "t-none" };
    expect(accountsMatchingPin(accs, pin, tagLinks)).toEqual([]);
  });

  it("account pin → only that account", () => {
    const pin: TabPin = { kind: "account", accountId: "b" };
    expect(accountsMatchingPin(accs, pin, tagLinks).map((a) => a.id)).toEqual(["b"]);
  });
});

describe("toTabPin", () => {
  it("each of the three kinds with its id → normalized TabPin", () => {
    expect(toTabPin({ kind: "connector", connectorId: "binance" })).toEqual({
      kind: "connector",
      connectorId: "binance",
    });
    expect(toTabPin({ kind: "tag", tagId: "t1" })).toEqual({ kind: "tag", tagId: "t1" });
    expect(toTabPin({ kind: "account", accountId: "a1" })).toEqual({
      kind: "account",
      accountId: "a1",
    });
  });

  it("missing kind / missing matching id → null (no narrowing)", () => {
    expect(toTabPin(undefined)).toBeNull();
    expect(toTabPin(null)).toBeNull();
    expect(toTabPin({ kind: "connector" })).toBeNull();
    expect(toTabPin({ kind: "tag" })).toBeNull();
    expect(toTabPin({ kind: "account" })).toBeNull();
    // kind/id mismatch (account kind with only tagId) → null, not mistaken for a tag
    expect(toTabPin({ kind: "account", tagId: "t1" })).toBeNull();
  });
});

// Which custom tabs make sense in this portfolio. Shared by placement and the cap count,
// so a bug here breaks both — pinned per kind.
describe("pinsInView", () => {
  const view = {
    accounts: [
      { id: "a1", connectorId: "binance" },
      { id: "a2", connectorId: "manual" },
    ],
    tagIds: new Set(["t1"]),
  };

  it("tag pin: shown only if the tag belongs to this portfolio", () => {
    const pins = [
      { id: "p1", kind: "tag" as const, tagId: "t1" },
      { id: "p2", kind: "tag" as const, tagId: "t-other" },
    ];
    expect(pinsInView(pins, view).map((p) => p.id)).toEqual(["p1"]);
  });

  it("account pin: shown only if the account is in this view", () => {
    const pins = [
      { id: "p1", kind: "account" as const, accountId: "a2" },
      { id: "p2", kind: "account" as const, accountId: "a-elsewhere" },
    ];
    expect(pinsInView(pins, view).map((p) => p.id)).toEqual(["p1"]);
  });

  it("connector pin: shown only if the view has an account of that connector", () => {
    const pins = [
      { id: "p1", kind: "connector" as const, connectorId: "binance" },
      { id: "p2", kind: "connector" as const, connectorId: "okx" },
    ];
    expect(pinsInView(pins, view).map((p) => p.id)).toEqual(["p1"]);
  });

  it("pin with a missing target id is not shown (any kind)", () => {
    const pins = [
      { id: "p1", kind: "tag" as const, tagId: null },
      { id: "p2", kind: "account" as const, accountId: null },
      { id: "p3", kind: "connector" as const, connectorId: null },
    ];
    expect(pinsInView(pins, view)).toEqual([]);
  });

  it("empty view (no accounts in the portfolio) → nothing shown", () => {
    const pins = [{ id: "p1", kind: "connector" as const, connectorId: "binance" }];
    expect(pinsInView(pins, { accounts: [], tagIds: new Set<string>() })).toEqual([]);
  });
});
