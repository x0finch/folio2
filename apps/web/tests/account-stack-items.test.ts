import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import { accountStackItems } from "@/routes/_authed/-accounts/list-stack-items";

const b = (
  p: Partial<OverviewBalance> & { symbol: string; usdValue: number },
): OverviewBalance => ({
  id: p.symbol,
  amount: 1,
  kind: "spot",
  metaJson: null,
  ...p,
});

// Perp rows: coin and notional live in meta and the row's usdValue is always 0 (positions add no net worth).
// Fixtures must match that: a non-zero usdValue once hid a sort-by-usdValue bug. Negative notional = short.
const perp = (coin: string, notional: number, logo?: string): OverviewBalance =>
  b({
    symbol: coin,
    usdValue: 0,
    logo,
    kind: "perp_position",
    id: `perp-${coin}`,
    metaJson: JSON.stringify({
      coin,
      side: notional >= 0 ? "long" : "short",
      entryPx: 1,
      positionValue: notional,
      unrealizedPnl: 0,
      liquidationPx: null,
      marginUsed: 10,
    }),
  });

// DeFi legs: protocol name and logo live in meta.
const defi = (protocol: string | null, usdValue: number, protocolLogo?: string): OverviewBalance =>
  b({
    symbol: "aUSDC",
    usdValue,
    kind: "defi",
    id: `defi-${protocol}-${usdValue}`,
    metaJson: JSON.stringify({ ...(protocol ? { protocol } : {}), protocolLogo }),
  });

describe("accountStackItems", () => {
  describe("spot", () => {
    it("dedupes by symbol (case-insensitive) and sums value, keeping the first symbol/logo", () => {
      const items = accountStackItems([
        b({ symbol: "ETH", usdValue: 100, logo: "eth.png" }),
        b({ symbol: "eth", usdValue: 50 }),
      ]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: "ETH", logo: "eth.png", k: "ETH" });
    });

    it("sorts by summed value descending", () => {
      const items = accountStackItems([
        b({ symbol: "A", usdValue: 10 }),
        b({ symbol: "B", usdValue: 100 }),
        b({ symbol: "C", usdValue: 50 }),
      ]);
      expect(items.map((i) => i.name)).toEqual(["B", "C", "A"]);
    });

    it("drops dust tokens (unpriced/airdrops, below the dust threshold)", () => {
      const items = accountStackItems([
        b({ symbol: "ETH", usdValue: 100 }),
        b({ symbol: "SPAM", usdValue: 0 }), // unpriced → excluded
        b({ symbol: "DUST", usdValue: 0.05 }), // < ZERO_DISPLAY_USD ($0.10) → excluded
      ]);
      expect(items.map((i) => i.name)).toEqual(["ETH"]);
    });

    it("keeps a symbol whose rows sum past the threshold (each row dust, sum non-zero)", () => {
      const items = accountStackItems([
        b({ symbol: "ETH", usdValue: 0.06 }),
        b({ symbol: "eth", usdValue: 0.06 }), // each < $0.10, sum 0.12 ≥ $0.10 → kept
      ]);
      expect(items.map((i) => i.name)).toEqual(["ETH"]);
    });

    it("empty → []", () => {
      expect(accountStackItems([])).toEqual([]);
    });
  });

  describe("perp positions", () => {
    it("shows the underlying coin with the enriched logo", () => {
      const items = accountStackItems([perp("BTC", 900, "btc.png")]);
      expect(items).toEqual([{ name: "BTC", logo: "btc.png", k: "BTC" }]);
    });

    it("equity row is not stacked — it is collateral, not a holding", () => {
      // Equity usually exceeds any single position and would crowd out what is being traded.
      const items = accountStackItems([
        perp("ETH", 100),
        b({ symbol: "USDC", usdValue: 5000, kind: "perp_equity" }),
      ]);
      expect(items.map((i) => i.name)).toEqual(["ETH"]);
    });

    it("short positions count too — notional uses the absolute value", () => {
      // Sorting by signed notional would push big shorts last or filter them as dust.
      const items = accountStackItems([perp("BTC", -900), perp("ETH", 100)]);
      expect(items.map((i) => i.name)).toEqual(["BTC", "ETH"]);
    });

    it("skips rows with broken meta (no empty logo slot)", () => {
      const broken = b({ symbol: "??", usdValue: 500, kind: "perp_position", metaJson: "{oops" });
      expect(accountStackItems([broken])).toEqual([]);
    });

    it("spot and perp of the same coin merge into one slot (no duplicate logos)", () => {
      const items = accountStackItems([
        b({ symbol: "BTC", usdValue: 100, logo: "btc.png" }),
        perp("btc", 900),
      ]);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ name: "BTC", logo: "btc.png" });
    });
  });

  describe("DeFi", () => {
    it("one slot per protocol, logo via the /api/logo/defi proxy (no third-party CDN on the client)", () => {
      const items = accountStackItems([defi("Aave", 500, "https://cdn.example/aave.png")]);
      expect(items).toEqual([{ name: "Aave", logo: "/api/logo/defi/Aave", k: "protocol:Aave" }]);
    });

    it("legs of one protocol merge, amount is the sum of absolute values", () => {
      // A 500 supply / -480 borrow hedge nets to 20 yet is the account's largest item: use gross exposure,
      // consistent with dropEmptyDefiGroups.
      const items = accountStackItems([
        defi("Aave", 500),
        defi("Aave", -480),
        b({ symbol: "ETH", usdValue: 100 }),
      ]);
      expect(items.map((i) => i.name)).toEqual(["Aave", "ETH"]);
    });

    it("missing protocol name → fallback group, slot kept", () => {
      const items = accountStackItems([defi(null, 500)]);
      expect(items.map((i) => i.name)).toEqual(["Other"]);
    });

    it("no protocol logo → empty logo (AvatarStack falls back to initials, no request)", () => {
      const items = accountStackItems([defi("Lido", 500)]);
      expect(items[0].logo).toBeUndefined();
    });

    it("a protocol and a same-named token are separate slots — Aave the protocol vs AAVE the coin", () => {
      const items = accountStackItems([defi("Aave", 500), b({ symbol: "Aave", usdValue: 100 })]);
      expect(items.map((i) => i.k)).toEqual(["protocol:Aave", "AAVE"]);
    });
  });

  it("mixed kinds: each its own slot, sorted by magnitude", () => {
    const items = accountStackItems([
      b({ symbol: "ETH", usdValue: 300 }),
      perp("BTC", 900),
      defi("Lido", 500),
      b({ symbol: "USDC", usdValue: 5000, kind: "perp_equity" }), // collateral, excluded
    ]);
    expect(items.map((i) => i.name)).toEqual(["BTC", "Lido", "ETH"]);
  });
});
