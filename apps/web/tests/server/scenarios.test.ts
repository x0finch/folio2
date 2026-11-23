import { env } from "cloudflare:test";
import type { SnapshotWithBalances } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOverview,
  deriveLiveAccountTotals,
  overviewChainIds,
  overviewEnrichIds,
  toTokenView,
} from "@/lib/core/portfolio";
import { connectorPlatformMeta } from "@/lib/server/connectors/platform";
import type { AppError } from "@/lib/server/errors";
import { NAMER } from "@/lib/server/oracle";
import { runForUser, type UserServices } from "@/lib/server/runtime";
import { dbFor, globalDb } from "./db-effect";
import {
  addManualActivities,
  createManualAccount,
  createToken,
  injectManualSnapshots,
} from "./manual-fns";
import { syncOne } from "./sync-fns";
import { ticketOf } from "./ticket";

// User scenarios, each checked in three places: what was stored, its values, and what the screen row shows.
// Every function has its own tests but nothing walked the whole path (a custom coin borrowing a real coin's price; a
// picked coin missing its logo), and per-side tests can't catch a wrong value crossing a boundary. So this drives the real
// chain (real D1, real mint, real `buildOverview`) and stubs only fetching and outbound. Upstream is stubbed to record + throw:
// these paths never go outbound, so any call must be visible.

const USER = "user-scenarios";
const USDC_ID = "usd-coin";
const USDC_UPSTREAM = `${NAMER}/issued:${USDC_ID}`;
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MARKET_PRICE = 0.9998;

let outbound: string[] = [];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM global_token_ref_index").run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`scenario must not go outbound, but requested ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// -- check 3: the screen row --
// Mirrors the `getPortfolioOverview` server fn's assembly (read accounts/snapshots/settings -> inject manual synthesized items ->
// buildOverview) without re-implementing business logic, so order or dependency changes turn it red. Runs via the production kernel.
const run = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runForUser(userId, effect);

async function overview() {
  const [allAccounts, snapshots, settings] = await Promise.all([
    dbFor(USER).accounts.list(),
    dbFor(USER).snapshots.latest(),
    dbFor(USER).settings.get(),
  ]);
  const accounts = allAccounts.filter((a) => a.archivedAt == null);
  const byAccount = new Map<string, SnapshotWithBalances>(
    snapshots.map((s) => [s.snapshot.accountId, s]),
  );
  await injectManualSnapshots(USER, accounts, byAccount);
  // Real reference layer (real D1 store + real CoinGecko adapter, outbound stubbed), assembled like the overview:
  // one assembly feeds the aggregate `Oracle`, builds buildOverview's three dictionaries + refresh set, then called as a pure function.
  return run(
    USER,
    Effect.gen(function* () {
      const { tokens, platforms } = yield* Oracle;
      // Same as the production overview: full rows are narrowed via `toTokenView` before buildOverview.
      const enrichedRecords = yield* tokens.enrich(overviewEnrichIds(accounts, byAccount));
      const enriched = new Map(
        [...enrichedRecords].map(([id, r]) => [id, toTokenView(r)] as const),
      );
      const platformMeta = yield* platforms.resolve(
        overviewChainIds(accounts, byAccount, connectorPlatformMeta),
      );
      const liveTotals = deriveLiveAccountTotals(
        accounts,
        byAccount,
        enriched,
        settings.valuationMode,
      );
      return buildOverview(accounts, byAccount, {
        enriched,
        liveTotals,
        platformMeta,
        connectorMeta: connectorPlatformMeta,
        mode: settings.valuationMode,
      });
    }),
  );
}

const holdingOf = (view: Awaited<ReturnType<typeof overview>>, symbol: string) =>
  view.holdings.find((h) => h.token.symbol === symbol);

// -- checks 1/2: stored rows --
async function tokenRows() {
  const { results } = await env.DB.prepare(
    "SELECT id, symbol, name, logo, unit_price AS unitPrice, self_price AS selfPrice FROM tokens WHERE user_id = ? ORDER BY symbol",
  )
    .bind(USER)
    .all<{
      id: string;
      symbol: string;
      name: string;
      logo: string | null;
      unitPrice: number | null;
      selfPrice: number | null;
    }>();
  return results;
}

async function refRows(tokenId: string) {
  const { results } = await env.DB.prepare(
    "SELECT namer, local_name AS localName FROM token_refs WHERE user_id = ? AND token_id = ? ORDER BY namer",
  )
    .bind(USER, tokenId)
    .all<{ namer: string; localName: string }>();
  return results;
}

// Runs one refresh round on the reference layer through the real refresh path (`refreshStale`'s price and metadata halves),
// stubbing only CoinGecko's HTTP response; hand-writing `putInfo` would bypass `refreshStaleInfo` and leave symbol normalization untested.
// The stubbed symbol is deliberately lowercase (`usdc`), as CoinGecko really returns it.
async function upstreamRefreshed(tokenId: string): Promise<void> {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    outbound.push(url.pathname);
    const body = url.pathname.includes("/coins/markets")
      ? [
          {
            id: USDC_ID,
            symbol: "usdc", // upstream gives lowercase
            name: "USDC",
            image: "https://cgk/usdc.png",
            current_price: MARKET_PRICE,
            market_cap_rank: 5,
            price_change_percentage_24h: 0.01,
            last_updated: new Date(Date.now()).toISOString(),
          },
        ]
      : url.pathname.includes("/simple/price")
        ? { [USDC_ID]: { usd: MARKET_PRICE, usd_24h_change: 0.01 } }
        : (() => {
            throw new Error(`stub does not cover this endpoint: ${url.pathname}`);
          })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await run(
    USER,
    Effect.flatMap(Oracle, (o) => o.tokens.refreshStale([tokenId])),
  );
  // After refreshing, restore the throw-on-outbound stub: display assertions still require zero outbound calls.
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`scenario must not go outbound, but requested ${String(input)}`);
  });
}

// -- scenario 1: a coin picked in the dropdown --
describe("scenario: add a coin manually, picked USDC in the dropdown", () => {
  const add = () =>
    createManualAccount(
      USER,
      "M",
      JSON.stringify([
        { symbol: "USDC", unitPrice: "777", amount: "10", ticket: ticketOf(USDC_ID) },
      ]),
    );

  it("1 stored: one token row, with **only the upstream ref** attached", async () => {
    await add();
    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    // When a coin is picked, the provider ref and the upstream ref are the same string, so it dedupes to one (else a PK clash).
    expect(await refRows(rows[0].id)).toEqual([{ namer: NAMER, localName: `issued:${USDC_ID}` }]);
    expect(outbound).toEqual([]); // the write path goes nowhere
  });

  // Price is not stored in a tokens column: the opening price entered in the form becomes the ledger's first entry (the ledger is the only price source).
  it("2 data: symbol normalized to uppercase; opening price on the ledger, both tokens columns empty", async () => {
    await add();
    const [row] = await tokenRows();
    expect(row.symbol).toBe("USDC"); // not the lowercase coin id from the ticket
    expect(row.selfPrice).toBeNull();
    expect(row.unitPrice).toBeNull(); // upstream hasn't refreshed yet
    const { results } = await env.DB.prepare(
      "SELECT kind, price FROM manual_activity WHERE token_id = ?",
    )
      .bind(row.id)
      .all<{ kind: string; price: number | null }>();
    expect(results).toEqual([{ kind: "set", price: 777 }]);
  });

  it("3 display: after the upstream refresh, uses the market price and the upstream name/image", async () => {
    await add();
    const [row] = await tokenRows();
    await upstreamRefreshed(row.id);

    const h = holdingOf(await overview(), "USDC");
    expect(h?.token.id).toBe(row.id); // has an identity -> went through the enrich gate
    // The image goes through the proxy endpoint, not the upstream URL (browsers must not hit CGK's CDN, which would leak holdings).
    expect(h?.token.logo).toBe(`/api/logo/token/${row.id}`);
    expect(h?.totalValue).toBeCloseTo(10 * MARKET_PRICE, 6); // not 10 x 777
    expect(outbound).toEqual([]); // display is cache-only
  });

  // No price in either cache layer (fresh user, never refreshed): fall back to the user's unit price rather than $0;
  // after a refresh the market price takes over, pinned by the previous case.
  it("3 display: neither layer has a price yet -> falls back to the user's unit price, not $0", async () => {
    await add();
    const h = holdingOf(await overview(), "USDC");
    expect(h?.totalValue).toBe(10 * 777);
  });
});

// -- scenario 2: no coin picked, typed a same-named one --
describe("scenario: add a coin manually, not picked, typed USDC", () => {
  const add = () =>
    createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "USDC", unitPrice: "777", amount: "10" }]),
    );

  it("1 stored: one token row, only the `manual/custom:` ref, **not** the upstream one", async () => {
    await add();
    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(await refRows(rows[0].id)).toEqual([{ namer: "manual", localName: "custom:USDC" }]);
  });

  it("2 data: opening price on the ledger, market price always empty (no upstream to ask)", async () => {
    await add();
    const [row] = await tokenRows();
    expect(row.selfPrice).toBeNull();
    expect(row.unitPrice).toBeNull();
    const { results } = await env.DB.prepare("SELECT price FROM manual_activity WHERE token_id = ?")
      .bind(row.id)
      .all<{ price: number | null }>();
    expect(results).toEqual([{ price: 777 }]);
  });

  // Verified from the screen side: display must use the own price, not mark to market.
  it("3 display: uses their price, no logo -- even with a real same-named USDC in the reference layer", async () => {
    await add();
    // Another account picks the real USDC so the reference layer holds a refreshed, same-named coin with price and image.
    await createManualAccount(
      USER,
      "Picked",
      JSON.stringify([{ symbol: "USDC", unitPrice: "1", amount: "1", ticket: ticketOf(USDC_ID) }]),
    );
    // Refresh the picked row to have price and image; both rows are named USDC, told apart by their ref row.
    let pickedId: string | undefined;
    let customId: string | undefined;
    for (const r of await tokenRows()) {
      const namer = (await refRows(r.id))[0]?.namer;
      if (namer === NAMER) pickedId = r.id;
      if (namer === "manual") customId = r.id;
    }
    expect(pickedId).toBeDefined();
    expect(customId).toBeDefined();
    await upstreamRefreshed(pickedId as string);

    const view = await overview();
    const custom = view.holdings.find((h) => h.token.id === customId);
    expect(custom?.totalValue).toBe(10 * 777); // their own price
    expect(custom?.token.logo).toBeUndefined(); // didn't borrow the real USDC's image
    // Control: the real one on the same screen does have image and market price, else this passes even with nothing refreshed.
    const picked = view.holdings.find((h) => h.token.id === pickedId);
    expect(picked?.token.logo).toBe(`/api/logo/token/${pickedId}`);
    expect(picked?.totalValue).toBeCloseTo(MARKET_PRICE, 6);
    // Both are named USDC but don't aggregate: two rows on screen.
    expect(view.holdings.filter((h) => h.token.symbol === "USDC")).toHaveLength(2);
    expect(outbound).toEqual([]);
  });
});

// -- scenario 2, second half: the other write paths --
// Three entry points add a coin: (1) createManualAccount (first coin when creating; form has a unit-price field), (2) createToken
// (drawer "add a coin"; has a unit-price field), (3) addManualActivities (drawer "log an activity", mints the coin; no unit-price field).
// (3) is the risky one: the form only has the trade price and the unit price is backfilled asynchronously after picking a coin; a typed
// coin has no ticket so the backfill never runs and unitPrice stays 0. Every path needs a test.
describe("scenario: the other two write paths for adding a coin manually", () => {
  async function manualAccount() {
    const a = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "1", amount: "1", ticket: ticketOf("bitcoin") }]),
    );
    return a.id;
  }

  it("2 adding a coin in the drawer (createToken): typed name + unit price -> list uses that price", async () => {
    const accountId = await manualAccount();
    await createToken(USER, { accountId, symbol: "SSGS", unitPrice: 888, amount: 22 });

    const h = holdingOf(await overview(), "SSGS");
    expect(h?.totalValue).toBe(22 * 888);
  });

  // This path's form has no unit-price field, only the trade price. Check 2 expects `self_price` to stay NULL:
  // copying the trade price in would store a derived value; the price is computed at display time from the ledger.
  it("3 logging an activity also mints the coin: no price stored, screen uses the trade price", async () => {
    const accountId = await manualAccount();
    const res = await addManualActivities(USER, accountId, [
      {
        // Typed coin: no ticket, so the frontend's "backfill market price" never runs and unitPrice can only be 0.
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 22,
        occurredAt: Date.now(),
        price: 888, // the only number the user gave
      },
    ]);
    expect(res.ok).toBe(true);

    const [row] = (await tokenRows()).filter((r) => r.symbol === "SSGS");
    expect(row.selfPrice).toBeNull(); // 2 stored: never declared, so NULL; the trade price isn't copied in
    const h = holdingOf(await overview(), "SSGS");
    expect(h?.totalValue).toBe(22 * 888); // 3 screen: 22 x 888, not $0
    expect(h?.token.logo).toBeUndefined(); // typed coins have no image
  });

  // A user adding a coin a second time: logging a newer trade price makes the current value follow it.
  it("3 logging a newer trade price -> current value follows the latest entry", async () => {
    const accountId = await manualAccount();
    const base = Date.now();
    await addManualActivities(USER, accountId, [
      {
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 22,
        occurredAt: base,
        price: 888,
      },
    ]);
    await addManualActivities(USER, accountId, [
      {
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 1,
        occurredAt: base + 1,
        price: 999,
      },
    ]);
    expect(holdingOf(await overview(), "SSGS")?.totalValue).toBe(23 * 999);
  });

  // The ledger is the only price source, so the latest entry always wins, even if far below the opening price.
  it("3 the opening price is just one ledger entry -- a later trade price takes over", async () => {
    const accountId = await manualAccount();
    await createToken(USER, { accountId, symbol: "SSGS", unitPrice: 888, amount: 10 });
    await addManualActivities(USER, accountId, [
      {
        token: { symbol: "SSGS", unitPrice: 0 },
        kind: "add",
        amount: 1,
        occurredAt: Date.now() + 1,
        price: 1,
      },
    ]);
    const [row] = (await tokenRows()).filter((r) => r.symbol === "SSGS");
    expect(row.selfPrice).toBeNull(); // nobody writes that column any more
    expect(holdingOf(await overview(), "SSGS")?.totalValue).toBe(11 * 1);
  });
});

// -- scenario 3: on-chain wallet sync --
describe("scenario: an on-chain wallet syncs one USDC", () => {
  const onchainBalance = {
    symbol: "USDC",
    amount: 5,
    value: 5,
    kind: "spot" as const,
    tokenRef: USDC_ETH,
  };

  async function syncOnchain(): Promise<string> {
    // The global mapping table includes this contract -> mint identifies it by address (not symbol).
    await globalDb.refIndex.putAll(
      [{ chainRef: USDC_ETH, upstreamRef: USDC_UPSTREAM }],
      Date.now(),
    );
    // The warm set leaves a local candidate for the symbol tier so it doesn't try to go back to source (no outbound in this scenario).
    await dbFor(USER).cache.put(
      "warm",
      {
        asOf: Date.now(),
        rows: [
          {
            info: { ref: USDC_UPSTREAM, symbol: "USDC", name: "USDC" },
            price: { unitPrice: MARKET_PRICE, marketCapRank: 5, asOf: Date.now() },
          },
        ],
      },
      60 * 60 * 1000,
    );
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      label: "w",
      creds: null,
    });
    const res = await syncOne(USER, {
      account: (await dbFor(USER).accounts.list()).find((a) => a.id === account.id) as never,
      balances: [onchainBalance as never],
    });
    if (!res.ok || !res.snapshotId) throw new Error(`sync failed: ${res.error ?? "no snapshot"}`);
    return res.snapshotId;
  }

  it("1 stored: one token row, **two** refs attached -- the on-chain one + the upstream one", async () => {
    await syncOnchain();
    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    expect(await refRows(rows[0].id)).toEqual([
      { namer: NAMER, localName: `issued:${USDC_ID}` },
      { namer: "evm:1", localName: "contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
    ]);
  });

  it("2 data: the snapshot row's token_id points at that row (identity fixed at write time)", async () => {
    const snapshotId = await syncOnchain();
    const [row] = await tokenRows();
    // symbol / token_ref no longer live on snapshots: identity is only token_id; the upstream naming is looked up via token_refs.
    const { results } = await env.DB.prepare(
      "SELECT token_id AS tokenId FROM snapshot_balances WHERE snapshot_id = ?",
    )
      .bind(snapshotId)
      .all<{ tokenId: string | null }>();
    expect(results).toEqual([{ tokenId: row.id }]);
  });

  it("3 display: after a refresh, has the upstream's name and image", async () => {
    await syncOnchain();
    const [row] = await tokenRows();
    await upstreamRefreshed(row.id);

    const h = holdingOf(await overview(), "USDC");
    expect(h?.token.logo).toBe(`/api/logo/token/${row.id}`);
    expect(h?.totalAmount).toBe(5);
  });

  // Canonical aggregation: the same coin from on-chain and from the manual pick merges into one row.
  it("3 display: aggregates with the same USDC picked manually into one row, quantities added", async () => {
    await syncOnchain();
    await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "USDC", unitPrice: "1", amount: "10", ticket: ticketOf(USDC_ID) }]),
    );
    const rows = await tokenRows();
    expect(rows).toHaveLength(1); // same upstream ref -> same row, no second one created
    await upstreamRefreshed(rows[0].id);

    const view = await overview();
    const usdc = view.holdings.filter((h) => h.token.symbol === "USDC");
    expect(usdc).toHaveLength(1);
    expect(usdc[0].totalAmount).toBe(15); // 5 on-chain + 10 manual
    expect(usdc[0].sources).toHaveLength(2); // two sources, each visible
  });
});
