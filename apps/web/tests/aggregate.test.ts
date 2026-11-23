import { describe, expect, it } from "vitest";
import { type AggInput, buildCanonicalHoldings, type Holding } from "@/lib/core/portfolio";

// Holdings merge on token_id, fixed at snapshot write time; the read side never re-resolves identity.
// So these tests only check same-id merges / different-id splits, plus platform units, totals and sorting.
const zerion = { id: "z1", label: "Wallet", connectorId: "evm" };
const binance = { id: "b1", label: "Binance", connectorId: "binance" };
const hyper = { id: "h1", label: "HL", connectorId: "hyperliquid" };
const manual = { id: "m1", label: "Notes", connectorId: "manual" };

const row = (
  p: Partial<AggInput> & Pick<AggInput, "symbol" | "amount" | "value" | "account">,
): AggInput => ({
  kind: "spot",
  ...p,
});
const byKey = (hs: Holding[], key: string) => hs.find((h) => h.key === key);

describe("buildCanonicalHoldings", () => {
  // A bridged variant is a different token_id, so it naturally gets its own row.
  it("same token across chains + exchange + manual → one row; bridged variant separate, total unchanged", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDT",
        amount: 1000,
        value: 1000,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-usdt",
      }),
      // Bridged variant: resolved to a different token → different token_id.
      row({
        symbol: "USDT",
        amount: 500,
        value: 500,
        platform: "evm:42161",
        account: zerion,
        tokenId: "tk-usdt0",
      }),
      row({
        symbol: "USDT",
        amount: 2000,
        value: 2000,
        platform: "binance",
        account: binance,
        tokenId: "tk-usdt",
      }),
      row({
        symbol: "USDT",
        amount: 100,
        value: 100,
        // Manual's platform is "manual" — platform comes from the balance row, not the token identity.
        platform: "manual",
        account: manual,
        tokenId: "tk-usdt",
      }),
    ]);
    expect(hs).toHaveLength(2);
    const h = byKey(hs, "tk-usdt")!;
    // Identity is the token_id alone (vendor-neutral: survives an upstream id change).
    expect(h.token).toMatchObject({ id: "tk-usdt", symbol: "USDT" });
    expect(h.totalValue).toBe(3100);
    expect(h.totalAmount).toBe(3100); // total units across sources (chain + exchange + manual)
    // aggregate emits only platform.id; name is a key placeholder until the server resolves the real name/logo.
    const ids = ["binance", "evm:1", "manual"]; // value descending (venue key = connectorId)
    expect(h.sources.map((s) => s.platform.id)).toEqual(ids);
    expect(h.sources.map((s) => s.platform.name)).toEqual(ids); // name == key placeholder
    expect(byKey(hs, "tk-usdt0")?.totalValue).toBe(500);
    expect(hs.reduce((n, x) => n + x.totalValue, 0)).toBe(3600);
  });

  it("perp equity stays out: same-token spot merges, the equity row and its source are excluded", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDC", amount: 1000, value: 1000, account: zerion, tokenId: "tk-usdc" }),
      row({ symbol: "USDC", amount: 500, value: 500, account: zerion, tokenId: "tk-usdc" }),
      row({
        symbol: "USDC",
        amount: 300,
        value: 300,
        kind: "perp_equity", // perp equity — Perps tab only, not folded into token rows
        account: hyper,
        tokenId: "tk-usdc",
      }),
    ]);
    const h = byKey(hs, "tk-usdc")!;
    expect(h.totalValue).toBe(1500); // only the two spot rows; equity 300 excluded
    expect(h.totalAmount).toBe(1500);
    // Equity comes from the hyperliquid account → that source must not appear on the row
    expect(h.sources.find((s) => s.platform.id === "hyperliquid")).toBeUndefined();
  });

  // Rows without token_id (legacy imports) have no symbol; keying on symbol would collapse them into one
  // nameless holding with summed amounts. Key on the balance row id instead.
  it("rows without token_id get one row each by balance id, not one merged nameless row", () => {
    const hs = buildCanonicalHoldings([
      row({ id: "bal-1", symbol: "", amount: 1, value: 10, account: binance }),
      row({ id: "bal-2", symbol: "", amount: 1, value: 20, account: binance }),
    ]);
    expect(hs).toHaveLength(2);
    expect(hs.map((h) => h.totalValue).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it("allowlist: defi / perp positions stay out of Holdings (spot only)", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "ETH",
        amount: 1,
        value: 3000,
        kind: "defi",
        account: zerion,
        tokenId: "tk-e",
      }),
      row({
        symbol: "ETH",
        amount: 1,
        value: 0,
        kind: "perp_position",
        account: hyper,
        tokenId: "tk-e",
      }), // perp position (value=0), not aggregated
    ]);
    expect(hs).toHaveLength(0);
  });

  it("account×platform dedupe: two rows of one coin on the same account and platform → one source", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USDC",
        amount: 100,
        value: 100,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-usdc",
      }),
      row({
        symbol: "USDC",
        amount: 50,
        value: 50,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-usdc",
      }),
    ]);
    const h = byKey(hs, "tk-usdc")!;
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0]).toMatchObject({ amount: 150, value: 150 });
  });

  it("no USD value (unpriced/junk, value=0) → not in portfolio holdings", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "REAL", amount: 2, value: 50, account: binance, tokenId: "tk-real" }),
      row({ symbol: "SPAM", amount: 999999, value: 0, account: binance, tokenId: "tk-spam" }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.token.symbol).toBe("REAL");
  });

  it("token kept if its sources sum > 0 even when some source has value=0", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "AAA", amount: 1, value: 0, account: binance, tokenId: "tk-a" }),
      row({ symbol: "AAA", amount: 1, value: 5, account: hyper, tokenId: "tk-a" }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(5);
  });

  it("token carries unitPrice / marketCapRank (for the detail header)", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "BTC",
        amount: 1,
        value: 64789,
        account: binance,
        tokenId: "tk-btc",
        unitPrice: 64789,
        marketCapRank: 1,
      }),
    ]);
    expect(hs[0]!.token.unitPrice).toBe(64789);
    expect(hs[0]!.token.marketCapRank).toBe(1);
  });

  it("price/rank across sources take the first non-empty value, regardless of row order", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDC", amount: 100, value: 100, account: zerion, tokenId: "tk-usdc" }),
      row({
        symbol: "USDC",
        amount: 50,
        value: 50,
        account: binance,
        tokenId: "tk-usdc",
        unitPrice: 1,
        marketCapRank: 6,
      }),
    ]);
    const h = byKey(hs, "tk-usdc")!;
    expect(h.token.unitPrice).toBe(1);
    expect(h.token.marketCapRank).toBe(6);
  });

  it("platform unit = the platform the provider reported (not derived from token identity)", () => {
    const btc = { id: "x1", label: "BTC wallet", connectorId: "bitcoin" };
    const hs = buildCanonicalHoldings([
      row({
        symbol: "BTC",
        amount: 1,
        value: 60,
        platform: "bitcoin",
        account: btc,
        tokenId: "tk-btc",
      }),
      row({
        symbol: "ETH",
        amount: 1,
        value: 30,
        platform: "evm:1",
        account: zerion,
        tokenId: "tk-eth",
      }),
    ]);
    expect(hs.flatMap((h) => h.sources.map((s) => s.platform.id)).sort()).toEqual([
      "bitcoin",
      "evm:1",
    ]);
  });

  it("row without a platform → falls back to the account's connectorId", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDC", amount: 100, value: 100, account: binance, tokenId: "tk-usdc" }),
    ]);
    expect(hs[0]!.sources.map((s) => s.platform.id)).toEqual(["binance"]);
  });
});

// Rows without token_id: legacy snapshots only.
describe("fallback without token_id", () => {
  it("grouped per account + symbol — never merged across accounts by bare symbol", () => {
    const kraken = { id: "k1", label: "Kraken", connectorId: "kraken" };
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDT", amount: 50, value: 50, account: kraken }),
      row({ symbol: "USDT", amount: 70, value: 70, account: binance }),
    ]);
    expect(hs).toHaveLength(2);
    expect(byKey(hs, "no-token:k1:USDT")?.totalValue).toBe(50);
    expect(byKey(hs, "no-token:b1:USDT")?.totalValue).toBe(70);
  });

  it("rows with the same symbol in one account still merge (sources of one holding)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDT", amount: 50, value: 50, platform: "binance", account: binance }),
      row({ symbol: "USDT", amount: 20, value: 20, platform: "binance", account: binance }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(70);
    expect(hs[0]!.token.id).toBeUndefined(); // no identity → detail page gets no id
  });

  it("symbol is normalized before the fallback (case/whitespace ignored)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: " usdt ", amount: 50, value: 50, account: binance }),
      row({ symbol: "USDT", amount: 20, value: 20, account: binance }),
    ]);
    expect(hs).toHaveLength(1);
  });

  it("rows with token_id never merge with rows without", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "USDT", amount: 50, value: 50, account: binance, tokenId: "tk-usdt" }),
      row({ symbol: "USDT", amount: 20, value: 20, account: binance }),
    ]);
    expect(hs).toHaveLength(2);
  });
});

// Fiat holdings (kind="spot") use the spot aggregation; isFiat is passed to Holding.token so the hero's
// stablecoin share is judged by identity, not bare symbol.
describe("fiat aggregation (isFiat)", () => {
  it("fiat spot rows enter holdings, count toward net worth, and pass isFiat to Holding.token", () => {
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USD",
        amount: 100,
        value: 100,
        platform: "manual",
        account: manual,
        tokenId: "tk-usd",
        isFiat: true,
      }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(100); // counts toward net worth (caller sums totalValue)
    expect(hs[0]!.token).toMatchObject({ symbol: "USD", isFiat: true });
  });

  it("one fiat across accounts merges into one row by token_id (same key as crypto)", () => {
    const manual2 = { id: "m2", label: "Cash 2", connectorId: "manual" };
    const hs = buildCanonicalHoldings([
      row({
        symbol: "USD",
        amount: 100,
        value: 100,
        platform: "manual",
        account: manual,
        tokenId: "tk-usd",
        isFiat: true,
      }),
      row({
        symbol: "USD",
        amount: 40,
        value: 40,
        platform: "manual",
        account: manual2,
        tokenId: "tk-usd",
        isFiat: true,
      }),
    ]);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.totalValue).toBe(140);
    expect(hs[0]!.totalAmount).toBe(140);
    expect(hs[0]!.sources).toHaveLength(2); // one source per account
    expect(hs[0]!.token.isFiat).toBe(true);
  });

  it("non-fiat rows leave isFiat unset → Holding.token.isFiat undefined (no false flag)", () => {
    const hs = buildCanonicalHoldings([
      row({ symbol: "BTC", amount: 1, value: 65000, account: zerion, tokenId: "tk-btc" }),
    ]);
    expect(hs[0]!.token.isFiat).toBeUndefined();
  });
});
