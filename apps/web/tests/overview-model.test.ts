import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import type { TokenRecord } from "@folio/oracle-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { OverviewBalance } from "@/lib/core/account-view";
import {
  buildOverview,
  deriveLiveAccountTotals,
  FIRST_SYNC_WINDOW_MS,
  isFirstSyncPending,
  type OverviewInput,
  overviewChainIds,
  overviewEnrichIds,
  type PortfolioSnapshotData,
  toTokenView,
} from "@/lib/core/portfolio";
import { type OracleStub, runWithOracle } from "./oracle-stub";

// buildOverview is pure; `overviewEffect` is the thin Effect adapter (same as the production
// assembly) so cases can still use `runWithOracle(stub, ...)`.
type OverviewDeps = Omit<OverviewInput, "enriched" | "liveTotals" | "platformMeta">;
const overviewEffect = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  deps: OverviewDeps = {},
) =>
  Effect.gen(function* () {
    const { tokens, platforms } = yield* Oracle;
    // Same as production: full oracle rows are narrowed via `toTokenView` before buildOverview.
    const enrichedRecords = yield* tokens.enrich(
      overviewEnrichIds(accounts, byAccount, deps.prevByAccount),
    );
    const enriched = new Map([...enrichedRecords].map(([id, r]) => [id, toTokenView(r)] as const));
    const platformMeta = yield* platforms.resolve(
      overviewChainIds(accounts, byAccount, deps.connectorMeta),
    );
    const liveTotals = deriveLiveAccountTotals(
      accounts,
      byAccount,
      enriched,
      deps.mode ?? "self-first",
    );
    return buildOverview(accounts, byAccount, {
      ...deps,
      enriched,
      liveTotals,
      platformMeta,
    });
  });

const account = (id: string, label: string, connectorId = "evm", platform: string | null = null) =>
  ({ id, label, connectorId, platform, archivedAt: null }) as unknown as AccountSafe;

// All share one token_id by default; identity is fixed when the snapshot is written.
const bal = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: crypto.randomUUID(),
  symbol: "USDC",
  amount: 0,
  usdValue: 0,
  kind: "spot",
  tokenId: "usdc",
  metaJson: null,
  ...over,
});

const snap = (accountId: string, totalUsd: number, balances: OverviewBalance[]) =>
  ({
    snapshot: { accountId, totalUsd, takenAt: 1000 },
    balances,
  }) as unknown as SnapshotWithBalances;

// Fake tokens: look up whole rows by token_id. No price -> liveValue falls back to frozen usdValue.
const record = (id: string): TokenRecord => ({
  id,
  ref: "coingecko/issued:usd-coin",
  symbol: "USDC",
  name: "USD Coin",
  logo: "u.png",
  infoStale: false,
});
const tokens = {
  enrich: (ids: readonly string[]) => Effect.succeed(new Map(ids.map((id) => [id, record(id)]))),
};

// Fake platforms: each key resolves to "NAME:<key>"; manual has no logo. Checks that the read path
// overrides placeholder names and rewrites logos to proxy URLs (undefined when none).
const platforms = {
  resolve: (keys: readonly string[]) =>
    Effect.succeed(
      new Map(
        keys.map((k) => [
          k,
          { key: k, name: `NAME:${k}`, logo: k === "manual" ? undefined : `https://cgk/${k}.png` },
        ]),
      ),
    ),
};

// Default stubs for this group; cases swap one out only when needed.
const stub: OracleStub = { tokens, platforms };

describe("buildOverview", () => {
  it("aggregates across accounts into one Holding + platform decoration + total", async () => {
    const accounts = [account("a1", "Arb"), account("a2", "Cold", "manual")];
    const byAccount = new Map([
      [
        "a1",
        snap("a1", 100, [
          bal({
            platform: "evm:42161",
            amount: 100,
            usdValue: 100,
          }),
        ]),
      ],
      [
        "a2",
        snap("a2", 50, [
          // Manual: the ref's namer is a data source, but the platform is manual (only the provider knows).
          bal({
            kind: "manual",
            platform: "manual",
            amount: 50,
            usdValue: 50,
          }),
        ]),
      ],
    ]);

    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));

    // Two USDC rows (different accounts/platforms) merge into one Holding.
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0].token.symbol).toBe("USDC");
    expect(view.holdings[0].totalValue).toBe(150);
    expect(view.holdings[0].sources).toHaveLength(2);

    // Platform names come from platforms.resolve (overriding the aggregate key placeholder).
    expect(view.holdings[0].sources.map((s) => s.platform.name).sort()).toEqual([
      "NAME:evm:42161",
      "NAME:manual",
    ]);

    // Logos with an image become folio proxy URLs (`:` in the key is encoded); manual -> undefined.
    // The client never hits CoinGecko directly.
    const platformLogos = view.holdings[0].sources.map((s) => s.platform.logo);
    expect(platformLogos).toContain("/api/logo/platform/evm%3A42161");
    expect(platformLogos).toContain(undefined);

    expect(view.totalUsd).toBe(150);
    expect(view.holdingsSubtotal).toBe(150);
    expect(view.sections).toHaveLength(0); // no defi/perp
  });

  it("venue key (= connectorId) is decorated via connectorMeta, not platforms.resolve", async () => {
    // A binance CEX account reports platform = "binance" (the venue key is the connectorId).
    const accounts = [account("cex", "Binance", "binance")];
    const byAccount = new Map([
      ["cex", snap("cex", 100, [bal({ platform: "binance", amount: 100, usdValue: 100 })])],
    ]);

    // Record which keys platforms.resolve is asked for; the venue key must be excluded.
    const asked: string[] = [];
    const recordingPlatforms = {
      resolve: (keys: readonly string[]) =>
        Effect.sync(() => {
          asked.push(...keys);
          return new Map(
            keys.map((k) => [k, { key: k, name: `NAME:${k}`, logo: `https://cgk/${k}.png` }]),
          );
        }),
    };
    const connectorMeta = (key: string) =>
      key === "binance" ? { name: "Binance", logo: "https://cgk/markets/binance.jpg" } : null;

    const view = await runWithOracle(
      { ...stub, platforms: recordingPlatforms },
      overviewEffect(accounts, byAccount, { connectorMeta }),
    );

    const src = view.holdings[0].sources[0];
    expect(src.platform.id).toBe("binance");
    expect(src.platform.name).toBe("Binance"); // from the connector, not "NAME:binance"
    expect(src.platform.logo).toBe("/api/logo/platform/binance"); // proxy URL (no `:` -> no encoding needed)
    expect(asked).not.toContain("binance"); // not sent to platforms.resolve -> no CoinGecko round-trip
  });

  it("non-eligible (defi) goes to secondary sections, not Holdings", async () => {
    const accounts = [account("a1", "Arb")];
    const byAccount = new Map([
      [
        "a1",
        snap("a1", 100, [
          bal({
            symbol: "USDC",
            kind: "spot",
            amount: 100,
            usdValue: 100,
          }),
          bal({
            symbol: "aUSDC",
            kind: "defi",
            amount: 10,
            usdValue: 10,
            metaJson: '{"protocol":"aave"}',
          }),
        ]),
      ],
    ]);

    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));

    expect(view.holdings).toHaveLength(1); // spot USDC only
    expect(view.holdings[0].totalValue).toBe(100);
    expect(view.sections).toHaveLength(1); // defi goes to a secondary section
    expect(view.defiSubtotal).toBe(10);
  });

  it("perp equity is not in the token aggregate; it shows in the sections' Perps tab", async () => {
    const accounts = [account("h", "Hyper", "hyperliquid")];
    const meta = JSON.stringify({
      role: "equity",
      withdrawable: 900,
      totalMarginUsed: 100,
      totalNtlPos: 5000,
    });
    const byAccount = new Map([
      ["h", snap("h", 1000, [bal({ kind: "perp", amount: 1000, usdValue: 1000, metaJson: meta })])],
    ]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    // The aggregate is spot-only, so equity is absent from Holdings and subtotal (no double count).
    expect(view.holdings).toHaveLength(0);
    expect(view.holdingsSubtotal).toBe(0);
    // Equity still shows in the Perps tab via sections' perp.equity.
    expect(view.sections[0].perp?.equity?.accountValue).toBe(1000);
  });

  it("legacy perp equity row with corrupt metaJson: token aggregate is empty", async () => {
    const accounts = [account("h", "Hyper", "hyperliquid")];
    const byAccount = new Map([
      // Corrupt metaJson: viewKind -> perp_equity. Perp equity never enters the aggregate anyway.
      [
        "h",
        snap("h", 0, [bal({ kind: "perp", amount: 1000, usdValue: 1000, metaJson: "not json" })]),
      ],
    ]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    expect(view.holdings).toHaveLength(0);
    expect(view.holdingsSubtotal).toBe(0);
  });
});

// Fiat identity (isFiat) is derived from injected fiatRefs (tokenId -> fiat namer ref) via
// fiatCodeOf, never from the bare symbol: the enrich ref is the upstream namer's (null for fiat).
describe("buildOverview — fiat identity isFiat", () => {
  it("tokenId maps to an allowlisted fiat/issued ref -> Holding.token.isFiat is true", async () => {
    const accounts = [account("m", "Cash", "manual")];
    const byAccount = new Map([
      [
        "m",
        snap("m", 100, [
          bal({ tokenId: "tk-usd", platform: "manual", amount: 100, usdValue: 100 }),
        ]),
      ],
    ]);
    const fiatRefs = new Map([["tk-usd", "fiat/issued:USD"]]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, { fiatRefs }));
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0].token.isFiat).toBe(true);
    expect(view.holdings[0].totalValue).toBe(100); // counts toward net value / aggregate
  });

  it("non-USD fiat (EUR) is also true", async () => {
    const accounts = [account("m", "Cash", "manual")];
    const byAccount = new Map([
      [
        "m",
        snap("m", 50, [bal({ tokenId: "tk-eur", platform: "manual", amount: 50, usdValue: 55 })]),
      ],
    ]);
    const fiatRefs = new Map([["tk-eur", "fiat/issued:EUR"]]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, { fiatRefs }));
    expect(view.holdings[0].token.isFiat).toBe(true);
  });

  it("ref is not an allowlisted fiat (e.g. an upstream usd token) -> not fiat (ref wins over symbol)", async () => {
    const accounts = [account("a1", "W")];
    const byAccount = new Map([
      ["a1", snap("a1", 100, [bal({ tokenId: "tk-x", amount: 100, usdValue: 100 })])],
    ]);
    // Symbol happens to be USD, but fiatRefs gives an ordinary upstream token ref -> not fiat.
    const fiatRefs = new Map([["tk-x", "coingecko/issued:some-usd-token"]]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, { fiatRefs }));
    expect(view.holdings[0].token.isFiat).toBe(false);
  });

  it("no fiatRefs injected -> never fiat (safe default)", async () => {
    const accounts = [account("a1", "W")];
    const byAccount = new Map([
      ["a1", snap("a1", 100, [bal({ tokenId: "tk-usd", amount: 100, usdValue: 100 })])],
    ]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    expect(view.holdings[0].token.isFiat).toBe(false);
  });
});

// sections.account carries the platform (perp section headers show the venue).
describe("buildOverview —— sections.account.platform", () => {
  it("connectorMeta hit -> name + proxy logo; not injected -> undefined", async () => {
    const accounts = [account("h", "watch", "hyperliquid")];
    const meta = JSON.stringify({ withdrawable: 1, totalMarginUsed: 0, totalNtlPos: 0 });
    const pos = JSON.stringify({
      side: "long",
      entryPx: 1,
      positionValue: 1,
      unrealizedPnl: 0,
      liquidationPx: null,
      marginUsed: 0,
    });
    const byAccount = new Map([
      [
        "h",
        snap("h", 1, [
          bal({ kind: "perp_equity", amount: 1, usdValue: 1, metaJson: meta }),
          bal({ kind: "perp_position", symbol: "ETH", amount: 1, metaJson: pos }),
        ]),
      ],
    ]);
    const connectorMeta = (key: string) =>
      key === "hyperliquid" ? { key, name: "Hyperliquid", logo: "https://x/hl.png" } : null;
    const withMeta = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { connectorMeta }),
    );
    expect(withMeta.sections[0].account.platform).toEqual({
      name: "Hyperliquid",
      logo: `/api/logo/platform/${encodeURIComponent("hyperliquid")}`,
    });
    const noMeta = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    expect(noMeta.sections[0].account.platform).toBeUndefined();
  });
});

// An equity-only perp account (no positions) stays in sections so the Perps equity bar shows.
describe("buildOverview — equity-only perp account is not filtered out", () => {
  it("equity but no positions -> kept in sections (perp.equity set, positions empty)", async () => {
    const accounts = [account("h", "Hyper", "hyperliquid")];
    const meta = JSON.stringify({ withdrawable: 900, totalMarginUsed: 0, totalNtlPos: 0 });
    const byAccount = new Map([
      [
        "h",
        snap("h", 1000, [
          bal({ kind: "perp_equity", amount: 1000, usdValue: 1000, metaJson: meta }),
        ]),
      ],
    ]);
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].perp?.equity?.accountValue).toBe(1000);
    expect(view.sections[0].perp?.positions).toEqual([]);
  });
});

describe("buildOverview — 24h gain wiring (difference of two endpoints)", () => {
  const accounts = [account("a1", "Arb")];
  // Now: 1 USDC worth 110 (default stub has no price, so liveValue falls back to frozen usdValue).
  const byAccount = new Map([["a1", snap("a1", 110, [bal({ amount: 1, usdValue: 110 })])]]);
  // The "24h ago" group uses the same slim shape (snap).
  const prev = (id: string, ...balances: OverviewBalance[]) =>
    new Map([[id, snap(id, 0, balances)]]);

  it("with a start point -> row carries the real gain (now - 24h ago)", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, {
        prevByAccount: prev("a1", bal({ amount: 1, usdValue: 100 })),
      }),
    );
    expect(view.holdings[0].gain24h?.amount).toBeCloseTo(10, 6);
    expect(view.holdings[0].gain24h?.pct).toBeCloseTo(10, 6);
  });

  it("token bought today: start account lacked it -> start 0, whole value counts as today's gain (flows included)", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, {
        // 24h ago the account held a different token -> USDC starts at 0 (bought today).
        prevByAccount: prev(
          "a1",
          bal({ tokenId: "eth", symbol: "ETH", amount: 1, usdValue: 3000 }),
        ),
      }),
    );
    const g = view.holdings.find((h) => h.key === "usdc")?.gain24h;
    expect(g?.amount).toBeCloseTo(110, 6); // start 0 -> all of the current value
    expect(g?.pct).toBeNull(); // zero denominator -> pct null
  });

  // No baseline (empty start group) is always `—`, for new accounts and gaps alike; whether the
  // account is in the start group is the only criterion.
  it("no baseline (empty start group) -> portfolio and holdings null, UI renders `—`, not 0", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { prevByAccount: new Map() }),
    );
    expect(view.gain24h).toBeNull();
    expect(view.holdings[0].gain24h).toBeNull();
  });

  // A holding without token_id has nothing to compare against (start is keyed by token_id), so its
  // gain must be null, never `endpointGain(0, current)` posing as a full-value gain.
  it("holding without token_id -> gain null, not a full-value gain", async () => {
    const noTokenNow = new Map([
      ["a1", snap("a1", 110, [bal({ tokenId: null, amount: 1, usdValue: 110 })])],
    ]);
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, noTokenNow, {
        // a1 has a start point, but it has no token_id either -> start.token is empty.
        prevByAccount: prev("a1", bal({ tokenId: null, amount: 1, usdValue: 100 })),
      }),
    );
    const h = view.holdings.find((x) => x.token.id == null);
    expect(h).toBeDefined();
    expect(h?.gain24h).toBeNull();
  });

  it("no start group passed -> no gain (field absent)", async () => {
    const view = await runWithOracle(stub, overviewEffect(accounts, byAccount, {}));
    expect(view.holdings[0].gain24h).toBeUndefined();
    expect(view.gain24h).toBeUndefined();
  });

  it("row amounts sum to the portfolio figure (endpoint differences are additive)", async () => {
    const two = [account("a1", "Arb"), account("a2", "Cold", "manual")];
    const snaps = new Map([
      ["a1", snap("a1", 110, [bal({ amount: 1, usdValue: 110 })])],
      ["a2", snap("a2", 62, [bal({ tokenId: "eth", symbol: "ETH", amount: 2, usdValue: 62 })])],
    ]);
    const prevMap = new Map([
      ["a1", snap("a1", 0, [bal({ amount: 1, usdValue: 100 })])],
      ["a2", snap("a2", 0, [bal({ tokenId: "eth", symbol: "ETH", amount: 2, usdValue: 60 })])],
    ]);
    const view = await runWithOracle(stub, overviewEffect(two, snaps, { prevByAccount: prevMap }));
    const sum = view.holdings.reduce((s, h) => s + (h.gain24h?.amount ?? 0), 0);
    expect(sum).toBeCloseTo(12, 6); // +10 (USDC) + 2 (ETH)
    expect(view.gain24h?.amount).toBeCloseTo(sum, 6);
  });

  it("portfolio pct = sum of amounts / sum of starts, not the mean of row pcts", async () => {
    const two = [account("a1", "Arb"), account("a2", "Cold", "manual")];
    const snaps = new Map([
      ["a1", snap("a1", 110, [bal({ amount: 1, usdValue: 110 })])],
      ["a2", snap("a2", 62, [bal({ tokenId: "eth", symbol: "ETH", amount: 2, usdValue: 62 })])],
    ]);
    const prevMap = new Map([
      ["a1", snap("a1", 0, [bal({ amount: 1, usdValue: 100 })])],
      ["a2", snap("a2", 0, [bal({ tokenId: "eth", symbol: "ETH", amount: 2, usdValue: 60 })])],
    ]);
    const view = await runWithOracle(stub, overviewEffect(two, snaps, { prevByAccount: prevMap }));
    // Rows: +10% (100->110) and +3.33% (60->62); portfolio start 160 -> 12/160 = 7.5%, not the mean 6.67%.
    const avg = view.holdings.reduce((s, h) => s + (h.gain24h?.pct ?? 0), 0) / view.holdings.length;
    expect(view.gain24h?.pct).toBeCloseTo(7.5, 4);
    expect(view.gain24h?.pct).not.toBeCloseTo(avg, 2);
  });
});

// Rows must sum to the headline. Holdings only include nonzero current value, so a sold-out token
// would drop its gain from the rows (1 ETH -> 3000 USDC shows only "USDC +3000" against a 0 headline).
// Sold-out tokens keep a row: current value 0, gain = 0 - value 24h ago.
describe("buildOverview — sold-out tokens", () => {
  const accounts = [account("a1", "Arb")];
  const ethThen = bal({ tokenId: "eth", symbol: "ETH", amount: 1, usdValue: 3000 });

  it("all ETH swapped to USDC -> ETH keeps a row: value 0, gain -3000; rows sum to headline", async () => {
    const now = new Map([["a1", snap("a1", 3000, [bal({ amount: 3000, usdValue: 3000 })])]]);
    const prevMap = new Map([["a1", snap("a1", 0, [ethThen])]]);
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, now, { prevByAccount: prevMap }),
    );
    const eth = view.holdings.find((h) => h.token.id === "eth");
    expect(eth).toMatchObject({ totalValue: 0, totalAmount: 0, sources: [] });
    expect(eth?.gain24h).toEqual({ amount: -3000, pct: -100 });
    const sum = view.holdings.reduce((s, h) => s + (h.gain24h?.amount ?? 0), 0);
    expect(view.gain24h?.amount).toBeCloseTo(0, 9);
    expect(sum).toBeCloseTo(view.gain24h?.amount ?? Number.NaN, 9);
  });

  it("sold-out row keeps the enriched name and icon (not a blank row)", async () => {
    const now = new Map([["a1", snap("a1", 0, [])]]);
    const prevMap = new Map([["a1", snap("a1", 0, [ethThen])]]);
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, now, { prevByAccount: prevMap }),
    );
    const eth = view.holdings.find((h) => h.token.id === "eth");
    expect(eth?.token).toMatchObject({ id: "eth", name: "USD Coin" }); // the stub enriches every id to the USDC row
    expect(eth?.token.logo).toBeDefined();
  });

  it("a token already at 0 24h ago does not get a phantom row", async () => {
    const now = new Map([["a1", snap("a1", 10, [bal({ amount: 10, usdValue: 10 })])]]);
    const prevMap = new Map([
      ["a1", snap("a1", 0, [bal({ amount: 10, usdValue: 10 }), { ...ethThen, usdValue: 0 }])],
    ]);
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, now, { prevByAccount: prevMap }),
    );
    expect(view.holdings.map((h) => h.token.id)).toEqual(["usdc"]);
  });

  // Invariant under seeded random portfolios: spot only, every row has token_id -> row gains sum
  // exactly to the headline. Covers sold out, newly bought, zeroed, and baseline-less accounts.
  it("random portfolios: holding-row gains sum to the headline gain", async () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const value = () => (rand() < 0.3 ? 0 : Math.round(rand() * 1e6) / 100);
    const ids = ["t1", "t2", "t3", "t4", "t5"];
    for (let n = 0; n < 300; n++) {
      const accs = ["x1", "x2", "x3"]
        .slice(0, 1 + Math.floor(rand() * 3))
        .map((id) => account(id, id));
      const now = new Map<string, SnapshotWithBalances>();
      const prevMap = new Map<string, SnapshotWithBalances>();
      for (const a of accs) {
        const held = (p: number) =>
          ids
            .filter(() => rand() < p)
            .map((tokenId) => bal({ tokenId, symbol: tokenId, amount: 1, usdValue: value() }));
        const cur = held(0.5);
        now.set(
          a.id,
          snap(
            a.id,
            cur.reduce((s, b) => s + b.usdValue, 0),
            cur,
          ),
        );
        if (rand() < 0.8) prevMap.set(a.id, snap(a.id, 0, held(0.5)));
      }
      const view = await runWithOracle(stub, overviewEffect(accs, now, { prevByAccount: prevMap }));
      if (view.gain24h == null) continue; // no account with a baseline -> headline `—`, nothing to compare
      const sum = view.holdings.reduce((s, h) => s + (h.gain24h?.amount ?? 0), 0);
      expect(sum).toBeCloseTo(view.gain24h.amount, 6);
    }
  });
});

describe("buildOverview — DeFi protocol row 24h gain (difference of two endpoints)", () => {
  const lidoMeta = JSON.stringify({ protocol: "Lido", positionType: "staked" });
  const accounts = [account("w", "Wallet")];
  const byAccount = new Map([
    [
      "w",
      snap("w", 110, [
        bal({ kind: "defi", amount: 1, usdValue: 110, tokenId: "tk-staked", metaJson: lidoMeta }),
      ]),
    ],
  ]);
  const defiPrev = (...balances: OverviewBalance[]) => new Map([["w", snap("w", 0, balances)]]);

  it("protocol net value now minus 24h ago", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, {
        prevByAccount: defiPrev(
          bal({ kind: "defi", amount: 1, usdValue: 100, tokenId: "tk-staked", metaJson: lidoMeta }),
        ),
      }),
    );
    expect(view.sections[0].defi[0].gain24h?.amount).toBeCloseTo(10, 6);
  });

  it("denominator = start net value: a hedged position gaining 10k on 10k net shows +100%", async () => {
    // Supply 1.01M / borrow 0.99M: net 20k. Start net 10k -> +10k is +100% (accepted definition).
    const hedged = new Map([
      [
        "w",
        snap("w", 20_000, [
          bal({ kind: "defi", amount: 1, usdValue: 1_010_000, tokenId: "sup", metaJson: lidoMeta }),
          bal({ kind: "defi", amount: 1, usdValue: -990_000, tokenId: "bor", metaJson: lidoMeta }),
        ]),
      ],
    ]);
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, hedged, {
        prevByAccount: defiPrev(
          bal({ kind: "defi", amount: 1, usdValue: 1_000_000, tokenId: "sup", metaJson: lidoMeta }),
          bal({ kind: "defi", amount: 1, usdValue: -990_000, tokenId: "bor", metaJson: lidoMeta }),
        ),
      }),
    );
    const gain = view.sections[0].defi[0].gain24h;
    expect(gain?.amount).toBeCloseTo(10_000, 6); // net 20k - 10k
    expect(gain?.pct).toBeCloseTo(100, 4); // denominator = start net value 10k
    expect(gain?.start).toBeCloseTo(10_000, 6); // start net value is carried along (the merge side needs it)
  });

  it("empty start group -> null, UI renders `—`", async () => {
    const view = await runWithOracle(
      stub,
      overviewEffect(accounts, byAccount, { prevByAccount: new Map() }),
    );
    expect(view.sections[0].defi[0].gain24h).toBeNull();
  });
});

// First-sync pending: accounts exist but no snapshot yet -> show loading, not $0 as the answer.
// Only reads the `accounts` / `snapshots` slices.
describe("isFirstSyncPending", () => {
  const NOW_T = 1_700_000_000_000;
  // Per-account age (ms before now); snapshot count.
  const raw = (accountAges: number[], snapshots: number): PortfolioSnapshotData =>
    ({
      now: NOW_T,
      accounts: accountAges.map((age, i) => ({ id: `a${i}`, createdAt: NOW_T - age })),
      snapshots: Array.from({ length: snapshots }, (_, i) => [`a${i}`, {}]),
    }) as unknown as PortfolioSnapshotData;

  it("fresh account, zero snapshots -> first sync pending", () => {
    expect(isFirstSyncPending(raw([0, 0], 0))).toBe(true);
  });

  it("zero accounts (truly empty portfolio) -> not pending, render the empty state", () => {
    expect(isFirstSyncPending(raw([], 0))).toBe(false);
  });

  it("at least one snapshot landed -> no longer pending", () => {
    expect(isFirstSyncPending(raw([0, 0], 1))).toBe(false);
  });

  // Accounts long past the first-sync window with no snapshots (bad creds / never synced) must not
  // stay pending forever, or the hero is stuck on the skeleton; show $0 / empty instead.
  it("all accounts past the first-sync window, still zero snapshots -> not pending (show $0)", () => {
    const old = FIRST_SYNC_WINDOW_MS + 60_000;
    expect(isFirstSyncPending(raw([old, old], 0))).toBe(false);
  });

  it("mixed: one old account + one fresh, zero snapshots -> still pending (the fresh one is syncing)", () => {
    expect(isFirstSyncPending(raw([FIRST_SYNC_WINDOW_MS + 60_000, 0], 0))).toBe(true);
  });

  it("inputs not loaded yet (undefined) -> not pending", () => {
    expect(isFirstSyncPending(undefined)).toBe(false);
  });
});
