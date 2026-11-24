import { env } from "cloudflare:test";
import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "@/lib/core/history";
import { NAMER } from "@/lib/server/oracle";
import { dbFor, oracleDbFor } from "./db-effect";
import {
  addManualActivities,
  deleteManualActivity,
  editManualActivity,
  loadManualAccountLiveTotal,
  loadManualAccountSeries,
  loadManualHistoryRows,
} from "./manual-fns";
import { ticketOf } from "./ticket";

// Server integration: manual value history computed on read over a regular daily grid. Real D1 (Miniflare). Network-free: structural
// cases use tokens with no identifier (no oracle priceSeries fetch; price comes from the ledger (2) / unitPrice (3)); oracle-history
// cases (1) pre-seed token_daily_prices and pass `now` (priceSeries' real-today check skips today's bucket, so past buckets all hit cache).
// beforeEach resets (the pool doesn't isolate per-test storage).
const USER = "user-manual-grid";
const DAY = 86_400_000;
const B0 = 18518; // a UTC day index around 2020-08
const D0 = B0 * DAY; // day-aligned opening time keeps the bucket math clean

// No identifier (no coin picked) -> price from the ledger (2) / unitPrice (3); buildHistoricalPriceAt skips it, no fetch.
const localBtc = { symbol: "BTC", unitPrice: 100 };
// With identifier (coin picked) -> (1) uses the injected oracle history price.
const btcRef = { symbol: "BTC", unitPrice: 100, ticket: ticketOf("bitcoin") };
// Fiat cash: the ticket carries a fiat identity, so history uses the day's exchange rate, not a coin price.
const eurCash = {
  symbol: "EUR",
  unitPrice: 1.15,
  ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "EUR")),
};
const usdCash = {
  symbol: "USD",
  unitPrice: 1,
  ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "USD")),
};
// Fiat daily history rates are stored directly in token_daily_prices as `fiat/issued:<CODE>` (getDailyByRef; no tokenId translation).
async function seedFiatDaily(
  code: string,
  rows: { dayBucket: number; unitPrice: number }[],
): Promise<void> {
  await oracleDbFor(USER).tokenPrices.putDailyByRef(tokenRef.issued(FIAT_NAMER, code), rows);
}
// Historical prices are keyed by token_id (the reference layer's priceSeries takes the internal id), so persist the holding first,
// take the minted id, then seed prices on it.
async function seedDaily(
  accountId: string,
  rows: { dayBucket: number; unitPrice: number }[],
): Promise<void> {
  const [h] = await dbFor(USER).manual.listHoldings(accountId, NAMER);
  await oracleDbFor(USER).tokenPrices.putDaily(h.id, rows);
}

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM token_daily_prices").run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}
beforeEach(resetUser);

async function emptyAccount(label = "M") {
  return dbFor(USER).accounts.create({
    connectorId: "manual",
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });
}

describe("loadManualAccountSeries (grid)", () => {
  it("grid's first point anchors the first activity, last point is now; no identifier -> priced from the ledger (2), network-free", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    // now = D0+1d -> first activity D0 + end of day + now.
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 1 * 60000 }); // anchors the first activity
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 1 * 60000,
    }); // last point now
    expect(series.every((r) => r.totalUsd === 1 * 60000)).toBe(true);
  });

  it("(1) seeded history prices -> grid uses oracle history prices (not the ledger price), per day bucket", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      // Ledger price=99999, but a coin was picked (identifier) -> history uses oracle 50000/52000, not the ledger price.
      { token: btcRef, kind: "add", amount: 2, occurredAt: D0, price: 99999 },
    ]);
    // Seed the past two days' history prices; priceSeries' buckets are all in the past -> cache hits, no fetch.
    await seedDaily(acc.id, [
      { dayBucket: B0, unitPrice: 50000 },
      { dayBucket: B0 + 1, unitPrice: 52000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    // First activity D0 (bucket B0 -> 50000), last point now=D0+DAY (bucket B0+1 -> 52000); quantity 2. Oracle prices, not the ledger's 99999.
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 2 * 50000 });
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 2 * 52000,
    });
    expect(series.some((r) => r.totalUsd === 2 * 52000)).toBe(true); // really used B0+1's history price
  });

  // Fiat cash end to end: each point converts at that day's rate, not flattened by the rate frozen in the ledger at entry.
  it("(1) non-USD fiat: history points use that day's rate, not the ledger's frozen price", async () => {
    const acc = await emptyAccount();
    // Ledger price=1.15 (rate frozen at entry); fiat picked -> history uses the day's rates 1.2 / 1.1, not 1.15.
    await addManualActivities(USER, acc.id, [
      { token: eurCash, kind: "set", amount: 100, occurredAt: D0, price: 1.15 },
    ]);
    // Past two days' historical rates (buckets all in the past -> rateSeries hits cache, no fetch).
    await seedFiatDaily("EUR", [
      { dayBucket: B0, unitPrice: 1.2 },
      { dayBucket: B0 + 1, unitPrice: 1.1 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    // First activity D0 (bucket B0 -> 1.2), last point D0+DAY (bucket B0+1 -> 1.1); quantity 100. Day's rate, not the ledger's 1.15.
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 100 * 1.2 });
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 100 * 1.1,
    });
  });

  // USD cash: rate is always 1, x quantity throughout; no outbound, no rates to seed.
  it("(1) USD cash: x1 throughout, behavior unchanged", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: usdCash, kind: "set", amount: 500, occurredAt: D0, price: 1 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series.every((r) => r.totalUsd === 500)).toBe(true);
  });

  it("stock outside the window: first activity long before now, later daily points still carry the folded stock", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0, price: 60000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + 3 * DAY);
    expect(series[0].takenAt).toBe(D0); // anchors the first activity
    expect(series[series.length - 1].takenAt).toBe(D0 + 3 * DAY); // spreads to now
    expect(series.length).toBeGreaterThanOrEqual(4);
    expect(series.every((r) => r.totalUsd === 2 * 60000)).toBe(true);
  });

  // Regression: the drawer switches to a time window (since after the only activity); sampling by trade time left no points in the
  // window and the account looked empty. The grid fills every day, so points after since still reflect the stock folded from earlier
  // activity. Composes loadManualAccountSeries (real D1 grid) + window filter + buildAccountValueHistory like getAccountHistory does;
  // the window step lives in `loadAccountHistory` (the interface's upper bound), written the same way here.
  it("since window start later than the only activity -> window still shows the stock (non-empty), not dropped", async () => {
    const acc = await emptyAccount();
    // The only activity is at D0; window since = D0+2d (after the activity). now = D0+4d.
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0, price: 60000 },
    ]);
    const rows = await loadManualAccountSeries(USER, acc.id, D0 + 4 * DAY);
    const since = D0 + 2 * DAY; // window start later than the only activity (D0)
    const windowed = buildAccountValueHistory(
      rows
        .filter((r) => r.takenAt >= since)
        .map((r) => ({ takenAt: r.takenAt, totalUsd: r.totalUsd })),
    );
    // Old behavior: rows had only the D0 point -> empty after the since filter. Grid: a point every day after since, value = the carried 2x60000.
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.every((p) => p.total === 2 * 60000)).toBe(true);
  });

  it("backfilling an earlier activity -> grid start moves earlier + whole series recomputed", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0 + DAY, price: 50000 },
    ]);
    // First activity at D0+DAY (bucket B0+1), now=D0+DAY -> a single point.
    expect((await loadManualAccountSeries(USER, acc.id, D0 + DAY)).map((r) => r.takenAt)).toEqual([
      D0 + DAY,
    ]);
    // Backfill an add 1 at D0 -> the grid start returns to bucket B0.
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 40000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 1 * 40000 }); // start back at D0
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 3 * 50000,
    }); // last point: 1+2=3, (2) latest price 50000
  });

  it("deleting a past activity -> whole series recomputed, nothing stale", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 40000 },
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0 + DAY, price: 50000 },
    ]);
    const acts = await dbFor(USER).manual.listActivityByAccount(acc.id);
    const later = acts.find((a) => a.occurredAt === D0 + DAY);
    if (!later) throw new Error("later activity missing");
    await deleteManualActivity(USER, acc.id, later.id);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 1 * 40000 });
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 1 * 40000,
    }); // stock 1 carried, no stale 3x50000
    expect(series.every((r) => r.totalUsd === 1 * 40000)).toBe(true);
  });

  it("editing a past activity's amount -> downstream recomputed", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 40000 },
    ]);
    const act = (await dbFor(USER).manual.listActivityByAccount(acc.id))[0];
    const res = await editManualActivity(USER, act.id, { amount: 3 });
    expect(res.ok).toBe(true);
    expect(await loadManualAccountSeries(USER, acc.id, D0)).toEqual([
      { accountId: acc.id, takenAt: D0, totalUsd: 3 * 40000 },
    ]);
  });

  it("deleting the opening set oversells the ledger -> last value clamps to 0 step by step then recovers, not zeroed (real-world regression)", async () => {
    const acc = await emptyAccount();
    // set10 opening, then add1 / reduce2 / add1 (runningOk never oversells at write time: 10->11->9->10).
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "set", amount: 10, occurredAt: D0, price: 50000 },
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0 + DAY, price: 60000 },
      { token: localBtc, kind: "reduce", amount: 2, occurredAt: D0 + 2 * DAY, price: 61000 },
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0 + 3 * DAY, price: 62000 },
    ]);
    // Deleting the opening set10 makes the ledger oversell in hindsight: add1 / reduce2 / add1 (delete doesn't revalidate oversell).
    const setAct = (await dbFor(USER).manual.listActivityByAccount(acc.id)).find(
      (x) => x.occurredAt === D0,
    );
    if (!setAct) throw new Error("set activity missing");
    await deleteManualActivity(USER, acc.id, setAct.id);

    const series = await loadManualAccountSeries(USER, acc.id, D0 + 3 * DAY);
    // Step by step: add1->1, reduce2->0, add1->1. Last point quantity 1 (not (1-2+1)=0), value = 1 x ledger price (2) 62000.
    const last = series[series.length - 1];
    expect(last.totalUsd).toBe(1 * 62000);
    expect(last.totalUsd).toBeGreaterThan(0); // key regression: deleting the opening no longer zeroes everything
  });

  it("empty account -> empty series", async () => {
    const acc = await emptyAccount();
    expect(await loadManualAccountSeries(USER, acc.id, D0)).toEqual([]);
  });
});

describe("loadManualHistoryRows (grid)", () => {
  it("merges the grids of several active manual accounts, each with its own accountId", async () => {
    const a = await emptyAccount("A");
    const b = await emptyAccount("B");
    await addManualActivities(USER, a.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    await addManualActivities(USER, b.id, [
      {
        token: { symbol: "ETH", unitPrice: 10 },
        kind: "add",
        amount: 2,
        occurredAt: D0,
        price: 3000,
      },
    ]);
    // now = D0 -> single point per account.
    const rows = await loadManualHistoryRows(USER, await dbFor(USER).accounts.list(), D0);
    expect(rows).toEqual(
      expect.arrayContaining([
        { accountId: a.id, takenAt: D0, totalUsd: 60000 },
        { accountId: b.id, takenAt: D0, totalUsd: 6000 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  // An archived account's grid is drawn only up to the sealing moment, not all the way to the caller's now: otherwise a year-old archived
  // account would rebuild a year of daily points (with price lookups) on every home open, all excluded from sums and padding the curve.
  it("archived account's grid is cut at the sealing moment, doesn't keep growing with now", async () => {
    const a = await emptyAccount("A");
    const archived = await emptyAccount("Z");
    await addManualActivities(USER, a.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    await addManualActivities(USER, archived.id, [
      { token: localBtc, kind: "add", amount: 5, occurredAt: D0, price: 60000 },
    ]);
    await dbFor(USER).accounts.setArchived(archived.id, true);
    // Move the sealing moment to D0 (same day as the activity) while the caller wants a curve three days past D0.
    await env.DB.prepare("UPDATE accounts SET archived_at = ? WHERE id = ?")
      .bind(D0, archived.id)
      .run();
    const rows = await loadManualHistoryRows(
      USER,
      await dbFor(USER).accounts.list(),
      D0 + 3 * 86_400_000,
    );
    // Active account is drawn to day 4 (D0..D0+3); the archived account has one point at D0.
    const forArchived = rows.filter((r) => r.accountId === archived.id);
    expect(forArchived).toHaveLength(1);
    expect(forArchived[0].takenAt).toBe(D0);
    expect(rows.filter((r) => r.accountId === a.id).length).toBeGreaterThan(1);
  });

  it("with an archived manual account: history keeps its past contribution", async () => {
    const a = await emptyAccount("A");
    const archived = await emptyAccount("Z");
    await addManualActivities(USER, a.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    await addManualActivities(USER, archived.id, [
      { token: localBtc, kind: "add", amount: 5, occurredAt: D0, price: 60000 },
    ]);
    await dbFor(USER).accounts.setArchived(archived.id, true);
    const rows = await loadManualHistoryRows(USER, await dbFor(USER).accounts.list(), D0);
    expect(rows).toEqual(
      expect.arrayContaining([
        { accountId: a.id, takenAt: D0, totalUsd: 60000 },
        { accountId: archived.id, takenAt: D0, totalUsd: 5 * 60000 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("loadManualAccountLiveTotal", () => {
  it("current live mark-to-market total (cold cache -> falls back to amount x the ledger's latest price)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 2, occurredAt: D0, price: 55000 },
    ]);
    // live marks to enrich's current price; cold cache in tests -> falls back to the 55000 in the **ledger** (the ledger is the only price source), 2 x 55000 = 110000.
    expect(await loadManualAccountLiveTotal(USER, acc.id)).toBe(110000);
  });

  it("account missing / not the caller's -> null", async () => {
    expect(await loadManualAccountLiveTotal(USER, "no-such-account")).toBeNull();
  });

  it("live compute-on-read: a stale materialized creds.tokens (amount 0) still folds from the ledger, not stuck stale", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    // Manually make the materialized projection stale (amount 0), simulating stale creds from before a fix.
    await dbFor(USER).accounts.setCredentials(
      acc.id,
      JSON.stringify({ tokens: JSON.stringify([{ symbol: "BTC", unitPrice: 100, amount: 0 }]) }),
    );
    // Live computes from the ledger (1 x the 60000 entry, cold cache fallback) = 60000, not stale creds' 0.
    expect(await loadManualAccountLiveTotal(USER, acc.id)).toBe(60000);
  });
});
