import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountIdsInView, accountsInView } from "@/lib/core/accounts-in-view";
import { buildPortfolioHistory, toPortfolioCurve } from "@/lib/core/history";
import { isManual } from "@/lib/core/manual";
import { deriveLiveAccountTotals, overviewEnrichIds } from "@/lib/core/portfolio";
import { injectManualSnapshots, loadManualHistoryRows } from "@/lib/server/manual/store";
import { handleGetPortfolioHistory } from "@/lib/server/portfolio/get-history";
import { PortfolioSelectInput, resolveScope } from "@/lib/server/portfolio/scope";
import { db } from "../_kit/db";
import { blockOutbound } from "../_kit/outbound";
import { call, readOverview } from "../_kit/run";
import { DAY, seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

describe("portfolio/get-history", () => {
  // The endpoint returns raw points; the curve is built client-side, so `curve()` replays the page's
  // read → assemble steps and assertions target the drawn line.
  const USER = "h-pf-history";
  const BTC = "token-btc";
  const ETH = "token-eth";

  let NOW = 0;
  const ago = (ms: number) => NOW - ms;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await freshUser(otherUser(USER));
    NOW = Date.now();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const curve = async (
    data: { portfolioId?: string; range?: "7d" | "30d" | "1y" | "all" } = {},
  ) => {
    const raw = await call(USER, handleGetPortfolioHistory(data));
    const overview = await readOverview(USER, data);
    return toPortfolioCurve(raw, overview);
  };

  describe("getPortfolioHistory", () => {
    it("two accounts with snapshots → curve in ascending time", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      await seedSnapshot(USER, a.id, ago(3 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(3 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 50 }]);
      await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
      await seedSnapshot(USER, b.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 60 }]);

      const series = await curve();

      const times = series.map((p) => p.t);
      expect([...times].sort((x, y) => x - y)).toEqual(times);
      expect(series.length).toBeGreaterThanOrEqual(2);
    });

    it("switching to a single-account portfolio → curve contains only it", async () => {
      const def = await db(USER).portfolios.ensureDefault();
      const other = await db(USER).portfolios.create({ name: "另一个" });
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      await db(USER).portfolios.assignAccount(a.id, def.id);
      await db(USER).portfolios.assignAccount(b.id, other.id);
      await seedSnapshot(USER, a.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(2 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 900 }]);
      await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(DAY), [{ tokenId: ETH, amount: 1, usdValue: 900 }]);

      const series = await curve({ portfolioId: other.id });

      // Only b → every point is 900, without a's 100.
      expect(series.every((p) => p.total >= 900)).toBe(true);
      // Other portfolios' rows aren't sent at all: scoping happens server-side.
      const raw = await call(USER, handleGetPortfolioHistory({ portfolioId: other.id }));
      expect(raw.rows.every((r) => r.accountId === b.id)).toBe(true);
    });

    it("negative account value → summed as-is, curve may go negative", async () => {
      const a = await seedAccount(USER, "永续", "hyperliquid");
      await seedSnapshot(USER, a.id, ago(2 * DAY), [
        { tokenId: BTC, amount: 1, usdValue: -300, kind: "perp_equity" },
      ]);
      await seedSnapshot(USER, a.id, ago(DAY), [
        { tokenId: BTC, amount: 1, usdValue: -300, kind: "perp_equity" },
      ]);

      const series = await curve();

      expect(series.length).toBeGreaterThan(0);
      expect(series.some((p) => p.total < 0)).toBe(true);
    });

    it("new user → empty curve, no error", async () => {
      expect(await curve()).toEqual([]);
    });

    it("someone else's portfolioId → falls back to default", async () => {
      const theirPf = await db(otherUser(USER)).portfolios.ensureDefault();
      const mine = await seedAccount(USER, "我的", "bitcoin");
      await seedSnapshot(USER, mine.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, mine.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);

      const series = await curve({ portfolioId: theirPf.id });

      expect(series.length).toBeGreaterThan(0);
      expect(series.every((p) => p.total === 100)).toBe(true);
    });

    it("missing input → schema supplies defaults", () => {
      expect(PortfolioSelectInput.parse(undefined)).toEqual({});
    });

    // Raw and curve point counts are nearly equal, so assert shape: `rows` per account, no `series`.
    it("endpoint sends raw rows per account, no computed curve", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      await seedSnapshot(USER, a.id, ago(2 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(2 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 50 }]);

      const raw = await call(USER, handleGetPortfolioHistory({ range: "30d" }));

      expect(Object.keys(raw).sort()).toEqual(["archivedAt", "liveAccountIds", "rows", "sampled"]);
      expect(raw.sampled).toBe(false);
      // Two accounts at the same instant are two rows (the curve would merge them).
      expect(raw.rows).toHaveLength(2);
      expect(raw.rows.map((r) => r.accountId).sort()).toEqual([a.id, b.id].sort());
    });

    it("long window (all) → sampled, row count independent of history length", async () => {
      const acc = await seedAccount(USER, "甲", "bitcoin");
      const start = NOW - 120 * DAY;
      for (let i = 0; i < 120; i++) {
        await seedSnapshot(USER, acc.id, start + i * DAY, [
          { tokenId: BTC, amount: 1, usdValue: 100 + Math.sin(i / 3) * 50 },
        ]);
      }

      const raw = await call(USER, handleGetPortfolioHistory({ range: "all" }));

      expect(raw.sampled).toBe(true);
      // SQL caps rows per bucket server-side; downsampling happens client-side.
      expect(raw.rows.length).toBeLessThanOrEqual(200);
      expect(raw.rows.length).toBeGreaterThan(10);
      const curve = toPortfolioCurve(raw, { accountTotals: [] });
      expect(curve.length).toBeLessThanOrEqual(82);
    }, 30_000);

    // Manual rows join the SQL candidate instants, so a one-day crash in a synced account isn't
    // carried across manual instants into portfolio values that never existed.
    it("long window (all) + manual account → manual rows share candidate instants; every point is real", async () => {
      vi.useFakeTimers({ now: ago(100 * DAY), toFake: ["Date"] });
      const manual = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 100,
        amount: 2,
      });
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
      const acc = await seedAccount(USER, "甲", "bitcoin");
      const start = NOW - 120 * DAY + DAY / 3;
      const CRASH = 60;
      // A very old snapshot stretches "all" to 4+ years (~25-day buckets), so several manual
      // instants fall between candidates after the crash.
      await seedSnapshot(USER, acc.id, start - 1500 * DAY, [
        { tokenId: BTC, amount: 1, usdValue: 900 },
      ]);
      for (let i = 0; i < 120; i++) {
        await seedSnapshot(USER, acc.id, start + i * DAY, [
          { tokenId: BTC, amount: 1, usdValue: i === CRASH ? 100 : 1000 + ((i * 37) % 11) },
        ]);
      }

      const raw = await call(USER, handleGetPortfolioHistory({ range: "all" }));

      expect(raw.sampled).toBe(true);
      // Manual accounts are capped too (≤ 3 × 66 buckets + 1 = 199 rows per account).
      const manualRows = raw.rows.filter((r) => r.accountId === manual.id);
      expect(manualRows.length).toBeGreaterThan(0);
      expect(manualRows.length).toBeLessThanOrEqual(199);

      // Reference: step reconstruction over all snapshots and manual rows.
      const truthRows = [
        ...(await db(USER).snapshots.listTotals()),
        ...(await call(USER, loadManualHistoryRows([manual], NOW))),
      ];
      const truth = buildPortfolioHistory(truthRows);
      const valueAt = (t: number) => truth.filter((p) => p.t <= t).at(-1)?.total;
      const rebuilt = buildPortfolioHistory(raw.rows);
      expect(rebuilt.length).toBeGreaterThan(3);
      for (const p of rebuilt) expect(p.total).toBeCloseTo(valueAt(p.t) ?? Number.NaN, 6);
      // The crash day is still there, and only that one point shows it.
      const crashValue = Math.min(...truth.map((p) => p.total));
      expect(rebuilt.filter((p) => p.total === crashValue)).toHaveLength(1);
    }, 30_000);

    it("parity with the old server-side algorithm: identical curve on the same data", async () => {
      const a = await seedAccount(USER, "甲", "bitcoin");
      const b = await seedAccount(USER, "乙", "binance");
      const gone = await seedAccount(USER, "封存的", "okx");
      await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 2 });
      await seedSnapshot(USER, a.id, ago(5 * DAY), [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
      await seedSnapshot(USER, b.id, ago(4 * DAY), [{ tokenId: ETH, amount: 1, usdValue: 50 }]);
      await seedSnapshot(USER, gone.id, ago(4 * DAY), [{ tokenId: ETH, amount: 2, usdValue: 70 }]);
      await seedSnapshot(USER, a.id, ago(DAY), [{ tokenId: BTC, amount: 1, usdValue: 120 }]);
      // More than one point after the seal: the rightmost is replaced by the live total, so only
      // the middle one proves truncation happened.
      await seedSnapshot(USER, a.id, ago(DAY / 2), [{ tokenId: BTC, amount: 1, usdValue: 130 }]);
      // Archive two days ago, not now: `setArchived` stamps the current time, which would leave no
      // post-seal points and make the truncation check vacuous.
      vi.useFakeTimers({ now: ago(2 * DAY), toFake: ["Date"] });
      await db(USER).accounts.setArchived(gone.id, true);
      vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

      // Compare on a 7-day window: longer windows read daily totals that merge intraday points by
      // design. The fixture spans only 5 days.
      const legacy = await call(USER, legacyPortfolioHistory({ range: "7d" }));
      const served = await curve({ range: "7d" });

      expect(served).toEqual(legacy.series);
      // Guard against a vacuous fixture: a real curve whose last point was replaced by the live total.
      expect(served.length).toBeGreaterThan(2);
      expect(served.at(-1)?.total).not.toBe(served.at(-2)?.total);
      // Truncation really happened: un-archiving adds exactly its 70 to every post-seal point only.
      const sealedAt = ago(2 * DAY);
      await db(USER).accounts.setArchived(gone.id, false);
      const unsealed = await curve({ range: "7d" });
      expect(unsealed.map((p) => p.t)).toEqual(served.map((p) => p.t));
      expect(unsealed.filter((p) => p.t >= sealedAt).length).toBeGreaterThan(1);
      for (const [i, p] of unsealed.entries()) {
        expect(p.total).toBeCloseTo(served[i].total + (p.t >= sealedAt ? 70 : 0), 6);
      }
    });
  });
});

// The server-side curve algorithm from before it moved client-side, kept only as the parity reference.
const legacyPortfolioHistory = (data: {
  portfolioId?: string;
  range?: "7d" | "30d" | "1y" | "all";
}) =>
  Effect.gen(function* () {
    const store = yield* Database;
    const { selectedId, defaultId } = yield* resolveScope(data.portfolioId);
    const [rows, allAccounts, snapshots, settings, memberships] = yield* Effect.all(
      [
        store.snapshots.listTotals(),
        store.accounts.list(),
        store.snapshots.latest(),
        store.settings.get(),
        store.portfolios.listMemberships(),
      ],
      { concurrency: 5 },
    );
    const memberSet = accountIdsInView(
      allAccounts.map((a) => a.id),
      memberships,
      selectedId,
      defaultId,
    );
    const memberAccounts = allAccounts.filter((a) => memberSet.has(a.id));
    const accounts = accountsInView(allAccounts, memberships, selectedId, defaultId);
    const now = Date.now();
    const manualIds = new Set(
      memberAccounts.filter((a) => isManual(a.connectorId)).map((a) => a.id),
    );
    const snapRows = rows.filter((r) => !manualIds.has(r.accountId) && memberSet.has(r.accountId));
    const manualRows = yield* loadManualHistoryRows(memberAccounts, now);
    const archivedAt = new Map(
      memberAccounts.flatMap((a) => (a.archivedAt == null ? [] : [[a.id, a.archivedAt] as const])),
    );
    const series = buildPortfolioHistory([...snapRows, ...manualRows], archivedAt);
    if (series.length === 0) return { series };

    const byAccount = new Map(snapshots.map((s) => [s.snapshot.accountId, s]));
    yield* injectManualSnapshots(accounts, byAccount);
    const enriched = yield* Effect.flatMap(Oracle, (o) =>
      o.tokens.enrich(overviewEnrichIds(accounts, byAccount)),
    );
    const liveTotals = deriveLiveAccountTotals(
      accounts,
      byAccount,
      enriched,
      settings.valuationMode,
    );
    let grand = 0;
    for (const v of liveTotals.values()) grand += v;
    series[series.length - 1] = { ...series[series.length - 1], total: grand };
    return { series };
  });
