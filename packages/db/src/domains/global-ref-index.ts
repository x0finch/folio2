import type { TokenRef, TokenRefIndexRow } from "@folio/oracle-basic";
import { formatTokenRef, parseTokenRef } from "@folio/oracle-ref";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { chunk, type DbClient } from "../client";
import { globalTokenRefIndex } from "../schema";

// `global_token_ref_index`: on-chain address -> an upstream's name for the same coin.
// Deliberately has no user_id: it holds only public upstream data and can be rebuilt from scratch.
// Refreshed by a daily cron (~23k rows); sync only reads it.

// D1's ~100 bind-parameter limit is per statement, so pack rows into multi-row INSERTs
// (20 rows x 4 params) and statements into batches (50 per batch -> ~24 batches for the full table).
const ROWS_PER_STATEMENT = 20;
const STATEMENTS_PER_BATCH = 50;

// ~30k rows -> 6-7 keyset pages, each under 1 MB.
const PAGE_ROWS = 5000;

export interface RefIndexRow {
  chainRef: string;
  upstream: string;
  upstreamLocalName: string;
}

interface RefKey {
  chainRef: string;
  upstream: string;
}

export interface RefIndexDiffCounts {
  updated: number;
  inserted: number;
  deleted: number;
}

// upstream never contains `|`, so the first `|` splits unambiguously. Exported for tests only.
// Not NUL: that makes git/grep treat the file as binary.
export const refKey = (chainRef: string, upstream: string): string => `${upstream}|${chainRef}`;

/**
 * Diffs one page of stored rows against the expected full set. Consumes `expected` in place: hits
 * are removed, so whatever remains after all pages is new and must be inserted. Unchanged rows
 * produce no write, which keeps steady-state writes near zero.
 */
export function diffRefIndexPage(
  expected: Map<string, RefIndexRow>,
  page: readonly RefIndexRow[],
): { updates: RefIndexRow[]; deletes: RefKey[] } {
  const updates: RefIndexRow[] = [];
  const deletes: RefKey[] = [];
  for (const row of page) {
    const key = refKey(row.chainRef, row.upstream);
    const want = expected.get(key);
    if (want === undefined) {
      deletes.push({ chainRef: row.chainRef, upstream: row.upstream });
      continue;
    }
    if (want.upstreamLocalName !== row.upstreamLocalName) updates.push(want);
    expected.delete(key);
  }
  return { updates, deletes };
}

export const makeGlobalRefIndexStore = (client: DbClient) => {
  // Multi-row upsert, chunked two levels (rows per statement, statements per batch).
  const writeRefRows = (
    toWrite: readonly RefIndexRow[],
    updatedAt: number,
  ): Effect.Effect<void> => {
    const statementRows = chunk(toWrite, ROWS_PER_STATEMENT).filter((p) => p.length > 0);
    return Effect.forEach(
      chunk(statementRows, STATEMENTS_PER_BATCH),
      (batch) =>
        client.batch((db) =>
          batch.map((part) =>
            db
              .insert(globalTokenRefIndex)
              .values(part.map((r) => ({ ...r, updatedAt })))
              .onConflictDoUpdate({
                target: [globalTokenRefIndex.chainRef, globalTokenRefIndex.upstream],
                set: {
                  upstreamLocalName: sql`excluded.upstream_local_name`,
                  updatedAt: sql`excluded.updated_at`,
                },
              }),
          ),
        ),
      { discard: true },
    );
  };

  const deleteRefRows = (keys: readonly RefKey[]): Effect.Effect<void> =>
    Effect.forEach(
      chunk(keys, STATEMENTS_PER_BATCH),
      (batch) =>
        client.batch((db) =>
          batch.map((k) =>
            db
              .delete(globalTokenRefIndex)
              .where(
                and(
                  eq(globalTokenRefIndex.chainRef, k.chainRef),
                  eq(globalTokenRefIndex.upstream, k.upstream),
                ),
              ),
          ),
        ),
      { discard: true },
    );

  return {
    // Values are full upstream refs (`coingecko/issued:bitcoin`), ready to use. Misses are absent.
    lookup: (
      upstream: string,
      chainRefs: readonly TokenRef[],
    ): Effect.Effect<Map<TokenRef, TokenRef>> =>
      Effect.gen(function* () {
        const out = new Map<TokenRef, TokenRef>();
        if (chainRefs.length === 0) return out;
        // chain_ref is stored canonical; normalise input too so address casing doesn't miss.
        // Unparseable refs can't be in the table and are skipped.
        const canonical = new Map<TokenRef, TokenRef>(); // canonical -> caller's original string
        for (const raw of new Set(chainRefs)) {
          const parts = parseTokenRef(raw);
          if (parts.kind !== "unknown") canonical.set(formatTokenRef(parts), raw);
        }
        if (canonical.size === 0) return out;

        // Chunked for the bind-parameter limit: a few statements per sync, not one per ref.
        const parts = chunk([...canonical.keys()]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
            db
              .select({
                chainRef: globalTokenRefIndex.chainRef,
                upstreamLocalName: globalTokenRefIndex.upstreamLocalName,
              })
              .from(globalTokenRefIndex)
              .where(
                and(
                  eq(globalTokenRefIndex.upstream, upstream),
                  inArray(globalTokenRefIndex.chainRef, part),
                ),
              ),
          ),
        );
        // Keyed by the caller's original string.
        for (const rows of batches) {
          for (const r of rows) {
            const key = canonical.get(r.chainRef);
            if (key !== undefined) {
              out.set(key, formatTokenRef({ namer: upstream, localName: r.upstreamLocalName }));
            }
          }
        }
        return out;
      }),

    // Differential refresh: only changed rows are written; returns counts for the cron log.
    // Deleting delisted coins is safe because the upstream fetch only returns on full success, so
    // the set is complete. An empty set is a suspicious response and is a no-op, never a wipe.
    // Deletes are scoped to the upstreams present, so refreshing one namer never touches another's rows.
    putAll: (
      rows: readonly TokenRefIndexRow[],
      updatedAt: number,
    ): Effect.Effect<RefIndexDiffCounts> =>
      Effect.gen(function* () {
        const expected = new Map<string, RefIndexRow>();
        for (const r of rows) {
          const parts = parseTokenRef(r.upstreamRef);
          if (parts.kind === "unknown") continue;
          expected.set(refKey(r.chainRef, parts.namer), {
            chainRef: r.chainRef,
            upstream: parts.namer,
            upstreamLocalName: parts.localName,
          });
        }
        if (expected.size === 0) return { updated: 0, inserted: 0, deleted: 0 };

        const upstreams = [...new Set([...expected.values()].map((r) => r.upstream))];
        const updates: RefIndexRow[] = [];
        const deletes: RefKey[] = [];

        // Keyset pagination over the PK, diffing page by page.
        let cursor: RefKey | null = null;
        for (;;) {
          const after = cursor;
          const page: RefIndexRow[] = yield* client.query((db) =>
            db
              .select({
                chainRef: globalTokenRefIndex.chainRef,
                upstream: globalTokenRefIndex.upstream,
                upstreamLocalName: globalTokenRefIndex.upstreamLocalName,
              })
              .from(globalTokenRefIndex)
              .where(
                and(
                  inArray(globalTokenRefIndex.upstream, upstreams),
                  after
                    ? sql`(${globalTokenRefIndex.chainRef}, ${globalTokenRefIndex.upstream}) > (${after.chainRef}, ${after.upstream})`
                    : undefined,
                ),
              )
              .orderBy(globalTokenRefIndex.chainRef, globalTokenRefIndex.upstream)
              .limit(PAGE_ROWS),
          );
          if (page.length === 0) break;
          cursor = {
            chainRef: page[page.length - 1].chainRef,
            upstream: page[page.length - 1].upstream,
          };
          const diff = diffRefIndexPage(expected, page);
          for (const u of diff.updates) updates.push(u);
          for (const d of diff.deletes) deletes.push(d);
          if (page.length < PAGE_ROWS) break;
        }

        // Leftovers in `expected` are new; updates and inserts share one upsert.
        const writes = [...updates, ...expected.values()];
        yield* writeRefRows(writes, updatedAt);
        yield* deleteRefRows(deletes);

        return { updated: updates.length, inserted: expected.size, deleted: deletes.length };
      }),

    // none = never refreshed (first deploy needs a manual run). Derived from max(updated_at) rather
    // than a separate marker row that could drift.
    refreshedAt: (upstream: string): Effect.Effect<Option.Option<number>> =>
      Effect.map(
        client.query((db) =>
          db
            .select({ latest: max(globalTokenRefIndex.updatedAt) })
            .from(globalTokenRefIndex)
            .where(eq(globalTokenRefIndex.upstream, upstream)),
        ),
        (rows) => Option.fromNullable(rows[0]?.latest),
      ),
  };
};
