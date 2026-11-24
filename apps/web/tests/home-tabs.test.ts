import { describe, expect, it } from "vitest";
import type { PortfolioSnapshotData, PortfolioTabPinsData } from "@/lib/core/portfolio";
import { computeHomeTabStrip, kindPresence, resolvePinLabel } from "@/lib/core/portfolio";
import { kindTabsOf, pickShownTab, tabAfterUnpin } from "@/routes/_authed/-home/home-tabs";

describe("pickShownTab: home main tab fallback", () => {
  const known = (v: string) => ["tokens", "perps", "defi", "pin_a"].includes(v);

  it("recognized: used as is", () => {
    expect(pickShownTab("perps", "tokens", known)).toBe("perps");
    expect(pickShownTab("pin_a", "tokens", known)).toBe("pin_a");
  });

  it("pin not attached yet (previous still valid): stays on the previous, no flash back to the first tab", () => {
    expect(pickShownTab("pin_brand_new", "pin_a", known)).toBe("pin_a");
  });

  it("pin deleted / garbage typed by hand, and previous invalid too: falls back to the default tab", () => {
    expect(pickShownTab("pin_deleted", "pin_also_gone", known)).toBe("tokens");
    expect(pickShownTab("¯\\_(ツ)_/¯", "nope", known)).toBe("tokens");
  });

  it("empty string also falls back (URL edited to `?tab=`)", () => {
    expect(pickShownTab("", "", known)).toBe("tokens");
  });
});

describe("kindTabsOf: which of the three view tabs appear", () => {
  it("Tokens always shown", () => {
    expect(kindTabsOf(false, false)).toEqual(["tokens"]);
  });

  it("perps go after Tokens", () => {
    expect(kindTabsOf(true, false)).toEqual(["tokens", "perps"]);
  });

  it("DeFi goes last", () => {
    expect(kindTabsOf(false, true)).toEqual(["tokens", "defi"]);
  });

  it("both present: Tokens / Perps / DeFi", () => {
    expect(kindTabsOf(true, true)).toEqual(["tokens", "perps", "defi"]);
  });
});

describe("tabAfterUnpin: unpinning the current pin returns to the left neighbour, not back to Tokens", () => {
  const pins = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const kinds = kindTabsOf(true, false); // tokens, perps

  it("middle / end: previous pin", () => {
    expect(tabAfterUnpin("b", pins, kinds)).toBe("a");
    expect(tabAfterUnpin("c", pins, kinds)).toBe("b");
  });

  it("first pin: last view tab, not Tokens", () => {
    expect(tabAfterUnpin("a", pins, kinds)).toBe("perps");
  });

  it("with only the Tokens view, the first pin goes back to Tokens", () => {
    expect(tabAfterUnpin("a", [{ id: "a" }], kindTabsOf(false, false))).toBe("tokens");
  });
});

describe('kindPresence: same "has perps / DeFi" rule as the overview', () => {
  const empty = { perp: null, defi: [] };

  it("empty sections: neither tab shown", () => {
    expect(kindPresence([empty])).toEqual({ hasPerps: false, hasDefi: false });
  });

  it("perp equity present: perps tab shown (even without positions)", () => {
    expect(
      kindPresence([{ perp: { positions: [], equity: { accountValue: 100 } }, defi: [] }]),
    ).toEqual({ hasPerps: true, hasDefi: false });
  });

  it("perp positions present: perps tab shown", () => {
    expect(
      kindPresence([{ perp: { positions: [{ coin: "ETH" }], equity: null }, defi: [] }]),
    ).toEqual({ hasPerps: true, hasDefi: false });
  });

  it("perp object present but positions and equity empty: not shown (matches overview derive)", () => {
    expect(kindPresence([{ perp: { positions: [], equity: null }, defi: [] }])).toEqual({
      hasPerps: false,
      hasDefi: false,
    });
  });

  it("DeFi group present: DeFi tab shown", () => {
    expect(
      kindPresence([
        {
          perp: null,
          defi: [{ protocol: "Aave", rows: [{ id: "1", symbol: "GHO", amount: 1, usdValue: 10 }] }],
        },
      ]),
    ).toEqual({ hasPerps: false, hasDefi: true });
  });
});

describe("computeHomeTabStrip: builds the tab strip from snapshot + tabPins + tags", () => {
  const emptySnapshot = {
    accounts: [],
    snapshots: [],
    prevSnapshots: [],
    enriched: [],
    platformMeta: [],
    connectorMeta: [],
    fiatRefs: [],
    mode: "self-first" as const,
    now: 0,
  } satisfies PortfolioSnapshotData;

  const emptyTabPins = { pins: [], connectorMeta: [] } satisfies PortfolioTabPinsData;

  it("zero accounts: hasAccounts false, neither view tab shown", () => {
    expect(computeHomeTabStrip(emptySnapshot, emptyTabPins, [])).toEqual({
      hasAccounts: false,
      hasPerps: false,
      hasDefi: false,
      pins: [],
    });
  });

  it("perp equity present: hasPerps true", () => {
    const account = {
      id: "acc1",
      label: "永续",
      connectorId: "hyperliquid",
      archivedAt: null,
    } as PortfolioSnapshotData["accounts"][number];
    const strip = computeHomeTabStrip(
      {
        ...emptySnapshot,
        accounts: [account],
        snapshots: [
          [
            "acc1",
            {
              takenAt: 0,
              balances: [
                {
                  id: "b1",
                  amount: 1,
                  usdValue: 100,
                  kind: "perp_equity",
                  metaJson: JSON.stringify({
                    withdrawable: 60,
                    totalMarginUsed: 40,
                    totalNtlPos: 400,
                  }),
                },
              ],
            },
          ],
        ],
      },
      emptyTabPins,
      [],
    );
    expect(strip.hasAccounts).toBe(true);
    expect(strip.hasPerps).toBe(true);
    expect(strip.hasDefi).toBe(false);
  });

  it("pins only list what makes sense in the current portfolio", () => {
    const account = {
      id: "acc1",
      label: "我的钱包",
      connectorId: "bitcoin",
      archivedAt: null,
    } as PortfolioSnapshotData["accounts"][number];
    const strip = computeHomeTabStrip(
      { ...emptySnapshot, accounts: [account], snapshots: [] },
      {
        pins: [
          {
            id: "p1",
            kind: "tag",
            tagId: "tg1",
            connectorId: null,
            accountId: null,
            sortOrder: 0,
            userId: "u1",
          },
          {
            id: "p2",
            kind: "account",
            accountId: "acc1",
            connectorId: null,
            tagId: null,
            sortOrder: 1,
            userId: "u1",
          },
        ],
        connectorMeta: [],
      },
      [{ id: "tg1", portfolioId: "pf1", name: "长期", sortOrder: 0, userId: "u1", createdAt: 0 }],
    );
    expect(strip.pins.map((p) => p.name).sort()).toEqual(["我的钱包", "长期"]);
  });
});
describe("resolvePinLabel: display names of the three target kinds (browser-side resolution)", () => {
  const lookup = {
    tagName: (id: string) => (id === "tg1" ? "DeFi" : undefined),
    accountName: (id: string) => (id === "acc1" ? "Cold" : undefined),
    connector: (id: string) =>
      id === "binance"
        ? { name: "Binance", logo: "/api/logo/platform/binance" }
        : { name: "Unknown" },
  };

  it("tag: name, no image", () => {
    expect(resolvePinLabel({ kind: "tag", tagId: "tg1" }, lookup)).toEqual({ name: "DeFi" });
  });

  it("account: name, no image", () => {
    expect(resolvePinLabel({ kind: "account", accountId: "acc1" }, lookup)).toEqual({
      name: "Cold",
    });
  });

  it("connector: type name + proxied image", () => {
    expect(resolvePinLabel({ kind: "connector", connectorId: "binance" }, lookup)).toEqual({
      name: "Binance",
      logo: "/api/logo/platform/binance",
    });
  });

  it("referenced tag is gone: empty name, no crash", () => {
    expect(resolvePinLabel({ kind: "tag", tagId: "gone" }, lookup)).toEqual({ name: "" });
  });
});
