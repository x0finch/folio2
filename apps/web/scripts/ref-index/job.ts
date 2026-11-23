import { GlobalDatabase, provideRemoteDbClient, type RemoteSql } from "@folio/db";
import { GlobalRefIndexService } from "@folio/oracle";
import { type CoinGeckoConfig, coinGeckoUpstreamLayers } from "@folio/oracle-upstream-coingecko";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { toError } from "@/lib/server/errors";

// Second assembly point for the global ref-index refresh (the first is the Worker cron): same `GlobalRefIndexService`, `GlobalDatabase` ticket and CoinGecko adapter, but with a caller-supplied SQL transport (D1 REST / local SQLite / dry-run wrapper) on Node, with no 10ms CPU cap. No business logic here: fetch two endpoints, pure transform, diff write (`putAll`).

/** One round's tally: last change time before the refresh, rows given / skipped / chain mismatches, and rows updated / inserted / deleted. */
export interface RefreshReport {
  readonly lastRefreshedAt: number | null;
  readonly rows: number;
  readonly skipped: number;
  readonly unmatchedPlatforms: readonly string[];
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

/** Runs one round. Failure rejects an `Error`: upstream typed failures become readable text via the app's `toError` (same as the Worker); transport rejects (D1 down) are defects, surfaced as-is. */
export async function refreshRefIndex(
  sql: RemoteSql,
  coingecko: CoinGeckoConfig,
): Promise<RefreshReport> {
  const program = Effect.gen(function* () {
    const svc = yield* GlobalRefIndexService;
    const before = yield* svc.refreshedAt();
    const result = yield* svc.warm();
    return { lastRefreshedAt: Option.getOrNull(before), ...result };
  });
  const services = GlobalRefIndexService.Default.pipe(
    Layer.provide(Layer.merge(GlobalDatabase.Default, coinGeckoUpstreamLayers(coingecko).token)),
  );
  const exit = await Effect.runPromiseExit(
    program.pipe(provideRemoteDbClient(sql), Effect.mapError(toError), Effect.provide(services)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.squash(exit.cause);
  throw failure instanceof Error ? failure : new Error(String(failure));
}

/** What this round sent over the transport: reads, and write batches (dry-run writes are counted, not sent). */
export interface SqlTally {
  reads: number;
  writeBatches: number;
  writeStatements: number;
}

/** Wraps the transport with counting; with `dryRun` no write is sent down (reads still run so the diff uses the real table). A write is anything via `batch`; should one arrive via `query` (method `run`) it is blocked too: better to under-read than over-write. */
export function tallied(inner: RemoteSql, dryRun: boolean): { sql: RemoteSql; tally: SqlTally } {
  const tally: SqlTally = { reads: 0, writeBatches: 0, writeStatements: 0 };
  return {
    tally,
    sql: {
      query: async (stmt) => {
        if (stmt.method === "run") {
          tally.writeBatches += 1;
          tally.writeStatements += 1;
          return dryRun ? [] : inner.query(stmt);
        }
        tally.reads += 1;
        return inner.query(stmt);
      },
      batch: async (stmts) => {
        if (stmts.length === 0) return [];
        tally.writeBatches += 1;
        tally.writeStatements += stmts.length;
        return dryRun ? stmts.map(() => []) : inner.batch(stmts);
      },
    },
  };
}
