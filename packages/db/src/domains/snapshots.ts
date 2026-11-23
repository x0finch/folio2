import { type BalanceKind, Note } from "@folio/connectors-basic";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import type { DbClient } from "../client";
import type { Drizzle } from "../connect";
import type { NotFound } from "../errors";
import { accounts, snapshotBalances, snapshots } from "../schema";
import type { Snapshot, SnapshotBalance } from "../schema/types";
import {
  queryDailyPointsByAccount,
  recomputeDailyTotal,
  upsertDailyTotal,
  utcDay,
} from "./daily-totals";
import {
  ACCOUNT_SAMPLED_BUCKETS,
  HISTORY_SAMPLED_BUCKETS,
  queryCarryInTotals,
  queryDailyTotalsInScope,
  querySampledPointsByAccount,
  querySampledSteps,
  querySampledTotalsInScope,
} from "./history-minmax";
import { assertAccountOwned } from "./ownership";

// Snapshots: the balance slice written by each sync, plus total / history / paging reads.

// D1 allows 100 bind params per statement; snapshot_balances has 10 columns -> 8 rows per chunk.
// Adding a column means revisiting this, or accounts with many holdings fail "too many SQL variables".
const BALANCE_INSERT_CHUNK = 8;

// Collapse bucket: must equal the reader's finest bucket (one hour, last point wins), cut on
// absolute clock hours (`floor(t / HOUR)`), not "within an hour of the previous snapshot".
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Kinds the app's `viewKind` doesn't count as spot (everything else falls back to spot). Per-token
// value history counts spot only, matching the holdings aggregation.
const NON_SPOT_KINDS = ["defi", "perp", "perp_equity", "perp_position"] as const;

export interface SnapshotBalanceInput {
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  // Optional: files from older export versions lack it.
  platform?: string;
  selfPrice?: number; // provider-reported unit price
  // Token row id resolved before writing; display name is read from the token row. Optional only
  // because older import files lack it.
  tokenId?: string;
  meta?: Record<string, unknown>;
  note?: Note;
}

export interface WriteSnapshotInput {
  takenAt: number;
  totalUsd: number;
  note?: Note[];
  balances: SnapshotBalanceInput[];
}

// note is parsed into a single Note (missing/corrupt -> omitted).
export type SnapshotBalanceView = Omit<SnapshotBalance, "note"> & { note?: Note };

export interface SnapshotWithBalances {
  snapshot: Snapshot;
  note?: Note[]; // parsed from snapshot.note (missing/corrupt -> omitted)
  balances: SnapshotBalanceView[];
}

function parseBalanceNote(raw: string | null): Note | undefined {
  if (!raw) return undefined;
  try {
    const r = Note.safeParse(JSON.parse(raw));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

function parseAccountNote(raw: string | null): Note[] | undefined {
  if (!raw) return undefined;
  try {
    const r = Note.array().safeParse(JSON.parse(raw));
    return r.success && r.data.length > 0 ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export interface SnapshotTotal {
  accountId: string;
  takenAt: number;
  totalUsd: number;
}

/**
 * Compact positional tuples with note / meta left as raw JSON; parsing happens in the browser.
 * This read runs twice per page load, and per-row parse + re-serialisation would eat the free
 * tier's 10ms Worker CPU, while D1's `raw()` already returns arrays.
 */
export type SnapshotRawRow = [
  accountId: string,
  takenAt: number,
  totalUsd: number,
  note: string | null,
];
/** First column is the snapshot's account. Balance notes aren't sent: the reader never shows them. */
export type BalanceRawRow = [
  accountId: string,
  id: string,
  amount: number,
  usdValue: number,
  kind: string,
  selfPrice: number | null,
  platform: string | null,
  tokenId: string | null,
  metaJson: string | null,
];
export interface SnapshotRawRows {
  snapshots: SnapshotRawRow[];
  balances: BalanceRawRow[];
}

export const makeSnapshotStore = (client: DbClient, userId: string) => {
  /**
   * Raw variant of `latestWithBalances` via `db.values` (D1 `raw()`), skipping drizzle's row mapping.
   * The second query inlines the first as a subquery instead of `IN (?, ...)`, which avoids D1's ~100
   * bind-parameter limit and runs in D1 rather than on Worker CPU.
   */
  const latestRawRows = (bounds?: {
    upTo?: number;
    floor?: number;
  }): Effect.Effect<SnapshotRawRows> =>
    client.query(async (db) => {
      const upTo = bounds?.upTo != null ? sql` AND x.taken_at <= ${bounds.upTo}` : sql``;
      const floor = bounds?.floor != null ? sql` AND x.taken_at >= ${bounds.floor}` : sql``;
      const latestIds = sql`
        SELECT (
          SELECT x.id FROM ${snapshots} x
          WHERE x.account_id = a.id${upTo}${floor}
          ORDER BY x.taken_at DESC, x.rowid DESC
          LIMIT 1
        )
        FROM ${accounts} a
        WHERE a.user_id = ${userId}`;
      const snaps = await db.values<SnapshotRawRow>(sql`
        SELECT s.account_id, s.taken_at, s.total_usd, s.note
        FROM ${snapshots} s
        WHERE s.id IN (${latestIds})`);
      if (snaps.length === 0) return { snapshots: [], balances: [] };
      const balances = await db.values<BalanceRawRow>(sql`
        SELECT s.account_id, b.id, b.amount, b.usd_value, b.kind, b.self_price, b.platform,
               b.token_id, b.meta_json
        FROM ${snapshotBalances} b
        JOIN ${snapshots} s ON s.id = b.snapshot_id
        WHERE b.snapshot_id IN (${latestIds})`);
      return { snapshots: snaps, balances };
    });

  /**
   * Each account's latest snapshot within the optional `[floor, upTo]` window, plus its balances.
   * Accounts with no snapshot in the window are absent, which the reader takes as "no observation".
   * Constant query count regardless of account count.
   */
  const latestWithBalances = (bounds?: {
    upTo?: number;
    floor?: number;
  }): Effect.Effect<SnapshotWithBalances[]> =>
    Effect.gen(function* () {
      // One point lookup per account on the (account_id, taken_at) index, reading ~3 rows per
      // account regardless of history. `GROUP BY account_id` + max() reads ~2x all snapshots, and D1
      // bills (and errors) on rows_read. Ties within a millisecond take the later write via `rowid`,
      // which sits on the index entry; `id DESC` would need a table lookup (3 -> 5 rows per account).
      const snaps = yield* client.query((db) => {
        const x = alias(snapshots, "x");
        const conds = [eq(x.accountId, accounts.id)];
        if (bounds?.upTo != null) conds.push(lte(x.takenAt, bounds.upTo));
        if (bounds?.floor != null) conds.push(gte(x.takenAt, bounds.floor));
        const latestId = db
          .select({ id: x.id })
          .from(x)
          .where(and(...conds))
          .orderBy(desc(x.takenAt), desc(sql`"x"."rowid"`))
          .limit(1);
        return db
          .select(getTableColumns(snapshots))
          .from(accounts)
          .innerJoin(snapshots, eq(snapshots.id, latestId))
          .where(eq(accounts.userId, userId));
      });
      if (snaps.length === 0) return [];

      const balanceRows = yield* client.query((db) =>
        db
          .select()
          .from(snapshotBalances)
          .where(
            inArray(
              snapshotBalances.snapshotId,
              snaps.map((s) => s.id),
            ),
          ),
      );

      const bySnapshot = new Map<string, SnapshotBalanceView[]>();
      for (const b of balanceRows) {
        const { note, ...rest } = b;
        const view: SnapshotBalanceView = { ...rest, note: parseBalanceNote(note) };
        const arr = bySnapshot.get(b.snapshotId);
        if (arr) arr.push(view);
        else bySnapshot.set(b.snapshotId, [view]);
      }
      return snaps.map((snapshot) => ({
        snapshot,
        note: parseAccountNote(snapshot.note),
        balances: bySnapshot.get(snapshot.id) ?? [],
      }));
    });

  return {
    /**
     * Atomic write of snapshot + balances (one D1 batch). Returns the snapshot id.
     *
     * `collapseSameHour` deletes an existing snapshot in the same clock hour first, keeping one per
     * account per hour: charts only show the last point per hour anyway, and nothing else caps
     * write frequency. Off by default because imports go through here too, and an import restores
     * historical facts that must not be collapsed: forgetting to enable it costs space, forgetting
     * to disable it loses data.
     */
    write: (
      accountId: string,
      input: WriteSnapshotInput,
      opts?: { collapseSameHour?: boolean },
    ): Effect.Effect<string, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        const snapshotId = crypto.randomUUID();
        const balanceRows = input.balances.map((b) => ({
          id: crypto.randomUUID(),
          snapshotId,
          amount: b.amount,
          usdValue: b.usdValue,
          kind: b.kind,
          selfPrice: b.selfPrice ?? null,
          platform: b.platform ?? null,
          // Column is NOT NULL; the input type stays nullable so legacy imports compile, and their
          // null intentionally fails the constraint. The cast moves enforcement to the DB.
          tokenId: (b.tokenId ?? null) as string,
          metaJson: b.meta ? JSON.stringify(b.meta) : null,
          note: b.note ? JSON.stringify(b.note) : null,
        }));
        // One atomic batch; balances chunked under D1's 100-bind limit (see BALANCE_INSERT_CHUNK).
        const hourStart = Math.floor(input.takenAt / HOUR_MS) * HOUR_MS;
        yield* client.batch((db) => {
          const balanceInserts = [];
          for (let i = 0; i < balanceRows.length; i += BALANCE_INSERT_CHUNK) {
            balanceInserts.push(
              db.insert(snapshotBalances).values(balanceRows.slice(i, i + BALANCE_INSERT_CHUNK)),
            );
          }
          return [
            // Delete before insert, in the same batch: reversed, it would delete the new row too
            // (same hour); split across calls, a failure leaves the hour empty. The batch runs in
            // order as one transaction, so concurrent syncs can't leave two copies. Balances go via
            // ON DELETE CASCADE.
            ...(opts?.collapseSameHour
              ? [
                  db
                    .delete(snapshots)
                    .where(
                      and(
                        eq(snapshots.accountId, accountId),
                        gte(snapshots.takenAt, hourStart),
                        lt(snapshots.takenAt, hourStart + HOUR_MS),
                      ),
                    ),
                ]
              : []),
            db.insert(snapshots).values({
              id: snapshotId,
              accountId,
              takenAt: input.takenAt,
              totalUsd: input.totalUsd,
              note: input.note && input.note.length > 0 ? JSON.stringify(input.note) : null,
            }),
            ...balanceInserts,
            // Daily rollup in the same batch so it lands with the snapshot. After a collapse the
            // deleted row may have been the day's extreme, so recompute the whole day; plain
            // appends only merge in.
            opts?.collapseSameHour
              ? recomputeDailyTotal(db, accountId, utcDay(input.takenAt))
              : upsertDailyTotal(db, accountId, input.takenAt, input.totalUsd),
          ];
        });
        return snapshotId;
      }),

    listByAccount: (accountId: string): Effect.Effect<Snapshot[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) =>
          db
            .select()
            .from(snapshots)
            .where(eq(snapshots.accountId, accountId))
            .orderBy(desc(snapshots.takenAt)),
        );
      }),

    /**
     * Single-account curve: just (takenAt, totalUsd) ascending, windowed in WHERE so a long-synced
     * account doesn't ship its whole history. Separate from `listByAccount`, which returns full rows
     * including JSON columns.
     */
    listTotalsByAccount: (
      accountId: string,
      since?: number,
    ): Effect.Effect<{ takenAt: number; totalUsd: number }[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) =>
          db
            .select({ takenAt: snapshots.takenAt, totalUsd: snapshots.totalUsd })
            .from(snapshots)
            .where(
              since == null
                ? eq(snapshots.accountId, accountId)
                : and(eq(snapshots.accountId, accountId), gte(snapshots.takenAt, since)),
            )
            .orderBy(asc(snapshots.takenAt)),
        );
      }),

    /** Mid windows (7 days to 1 year): daily open/min/max/close, at most 4 points per day. */
    listDailyTotalsByAccount: (
      accountId: string,
      since?: number,
    ): Effect.Effect<{ takenAt: number; totalUsd: number }[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) => queryDailyPointsByAccount(db, accountId, since));
      }),

    /** Long windows (1y / all): bucketed in SQL; capped row count, extremes kept, no downsampling. */
    listSampledTotalsByAccount: (
      accountId: string,
      since?: number,
      buckets = ACCOUNT_SAMPLED_BUCKETS,
    ): Effect.Effect<{ takenAt: number; totalUsd: number }[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) =>
          querySampledPointsByAccount(db, accountId, since, buckets),
        );
      }),

    /** Mid windows: carry-in plus one daily close per account; shaped like `listTotals`. */
    listDailyTotals: (
      accountIds: readonly string[],
      since?: number,
    ): Effect.Effect<SnapshotTotal[]> =>
      client.query((db) => queryDailyTotalsInScope(db, userId, accountIds, since)),

    /**
     * Long windows: see `querySampledSteps`. At most 3 x buckets + 1 rows per account; shaped like
     * `listTotals`. `extra` carries manual accounts' steps so they join candidate picking too.
     */
    listSampledTotals: (
      accountIds: readonly string[],
      since?: number,
      buckets = HISTORY_SAMPLED_BUCKETS,
      extra: readonly SnapshotTotal[] = [],
    ): Effect.Effect<SnapshotTotal[]> =>
      client.query((db) =>
        querySampledTotalsInScope(db, userId, accountIds, since, buckets, extra),
      ),

    /**
     * Per-token spot value history: per (account x snapshot) sum, shaped like `listTotals`.
     * Summing and the spot test happen in SQL instead of reading every balance row into the Worker.
     * The spot test must match the app's `viewKind(kind) === "spot"`.
     *
     * `bucket`: "snapshot" = one row per snapshot (windows <= 7 days); "day" = last row per UTC day;
     * "sampled" = `querySampledSteps` on the cross-account timeline (1y / all).
     */
    listTokenValueTotals: (
      tokenId: string,
      since: number | undefined,
      bucket: "snapshot" | "day" | "sampled",
    ): Effect.Effect<SnapshotTotal[]> =>
      client.query(async (db) => {
        const perSnapshot = sql`
          SELECT s.account_id, s.taken_at, SUM(b.usd_value) AS total
          FROM ${snapshotBalances} b
          JOIN ${snapshots} s ON s.id = b.snapshot_id
          JOIN ${accounts} a ON a.id = s.account_id
          WHERE a.user_id = ${userId}
            AND b.token_id = ${tokenId}
            AND b.kind NOT IN (${sql.join(
              NON_SPOT_KINDS.map((k) => sql`${k}`),
              sql`, `,
            )})${since != null ? sql` AND s.taken_at >= ${since}` : sql``}
          GROUP BY s.id`;
        // Keeping only the last row per bucket would drop spikes mid-bucket, hence candidate sampling.
        if (bucket === "sampled") {
          return querySampledSteps(
            db,
            sql`tp AS (${perSnapshot}),
            p AS (SELECT account_id, taken_at AS t, total AS v, 1 AS ord FROM tp)`,
            HISTORY_SAMPLED_BUCKETS,
          );
        }
        const bucketExpr =
          bucket === "snapshot" ? sql`p.taken_at` : sql`CAST(p.taken_at / ${DAY_MS} AS INTEGER)`;
        const rows = await db.values<[string, number, number]>(sql`
          WITH p AS (${perSnapshot}),
          ranked AS (
            SELECT p.account_id, p.taken_at, p.total,
              ROW_NUMBER() OVER (
                PARTITION BY p.account_id, ${bucketExpr} ORDER BY p.taken_at DESC
              ) AS rn
            FROM p
          )
          SELECT account_id, taken_at, total FROM ranked WHERE rn = 1 ORDER BY taken_at
        `);
        return rows.map(([accountId, takenAt, totalUsd]) => ({ accountId, takenAt, totalUsd }));
      }),

    /** Totals only (no balances); the browser rebuilds the step series. */
    listTotals: (since?: number): Effect.Effect<SnapshotTotal[]> =>
      client.query(async (db) => {
        const windowRows = await db
          .select({
            accountId: snapshots.accountId,
            takenAt: snapshots.takenAt,
            totalUsd: snapshots.totalUsd,
          })
          .from(snapshots)
          .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
          .where(
            since == null
              ? eq(accounts.userId, userId)
              : and(eq(accounts.userId, userId), gte(snapshots.takenAt, since)),
          )
          .orderBy(asc(snapshots.takenAt));
        // Carry-in keeps stale accounts on the curve (see queryCarryInTotals). It must come before
        // windowRows: on a tie at `since` the browser's stable sort lets the real row win.
        if (since == null) return windowRows;
        const carryIn = await queryCarryInTotals(db, userId, null, since);
        return [...carryIn, ...windowRows];
      }),

    latest: (): Effect.Effect<SnapshotWithBalances[]> => latestWithBalances(),

    /**
     * The 24h P&L baseline: each account's latest snapshot at or before `t` (never after, which would
     * silently shorten the window) and not before `floor`. Accounts with nothing in the window are
     * absent, so the reader treats their change as 0 instead of comparing to a very old value.
     */
    asOf: (t: number, floor: number): Effect.Effect<SnapshotWithBalances[]> =>
      latestWithBalances({ upTo: t, floor }),

    /** Raw variant of `latest()` (compact tuples, JSON unparsed). */
    latestRaw: (): Effect.Effect<SnapshotRawRows> => latestRawRows(),

    /** Raw variant of `asOf`. */
    asOfRaw: (t: number, floor: number): Effect.Effect<SnapshotRawRows> =>
      latestRawRows({ upTo: t, floor }),

    /** For export: pages through snapshots with constant memory; ordered by takenAt, then id. */
    listPage: (limit: number, offset: number): Effect.Effect<Snapshot[]> =>
      client.query((db) =>
        db
          .select(getTableColumns(snapshots))
          .from(snapshots)
          .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
          .where(eq(accounts.userId, userId))
          .orderBy(asc(snapshots.takenAt), asc(snapshots.id))
          .limit(limit)
          .offset(offset),
      ),

    /**
     * Caller must keep ids within the page size (below D1's 100-bind limit). Takes no userId: it is
     * only called after `listPage` has already scoped the ids to the user.
     */
    balancesFor: (snapshotIds: string[]): Effect.Effect<SnapshotBalance[]> =>
      snapshotIds.length === 0
        ? Effect.succeed([])
        : client.query((db) =>
            db
              .select()
              .from(snapshotBalances)
              .where(inArray(snapshotBalances.snapshotId, snapshotIds)),
          ),

    /**
     * Clears display notes on old snapshots; returns counts. `olderThan` is epoch ms.
     * Only notes: `meta_json` is read by shared logic (24h P&L, kind detection), so clearing it would
     * corrupt history. Each account's latest snapshot is never cleared, or stopped accounts would lose
     * their only notes.
     */
    pruneNotes: (olderThan: number): Effect.Effect<{ snapshots: number; balances: number }> =>
      Effect.gen(function* () {
        // EXISTS a newer snapshot of the same account: uses the (account_id, taken_at) index directly.
        const notLatest = sql`exists (
            select 1 from ${snapshots} newer
            where newer.account_id = ${snapshots.accountId}
              and newer.taken_at > ${snapshots.takenAt}
          )`;
        const stale = (db: Drizzle) =>
          db
            .select({ id: snapshots.id })
            .from(snapshots)
            .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
            .where(and(eq(accounts.userId, userId), lt(snapshots.takenAt, olderThan), notLatest));

        // Count then update instead of `UPDATE ... RETURNING`: the first run after deploy touches
        // tens of thousands of rows, and RETURNING would materialise them all just for a count.
        // Not atomic, so concurrent writes can skew the logged count slightly; each UPDATE is
        // idempotent via `note IS NOT NULL`.
        const [snapCount] = yield* client.query((db) =>
          db
            .select({ n: count() })
            .from(snapshots)
            .where(and(isNotNull(snapshots.note), inArray(snapshots.id, stale(db)))),
        );
        const [balCount] = yield* client.query((db) =>
          db
            .select({ n: count() })
            .from(snapshotBalances)
            .where(
              and(
                isNotNull(snapshotBalances.note),
                inArray(snapshotBalances.snapshotId, stale(db)),
              ),
            ),
        );

        yield* client.batch((db) => [
          db
            .update(snapshots)
            .set({ note: null })
            .where(and(isNotNull(snapshots.note), inArray(snapshots.id, stale(db)))),
          db
            .update(snapshotBalances)
            .set({ note: null })
            .where(
              and(
                isNotNull(snapshotBalances.note),
                inArray(snapshotBalances.snapshotId, stale(db)),
              ),
            ),
        ]);
        return { snapshots: snapCount?.n ?? 0, balances: balCount?.n ?? 0 };
      }),
  };
};
