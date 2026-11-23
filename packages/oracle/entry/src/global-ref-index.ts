import type { UpstreamError } from "@folio/client-core";
import { type DbClient, GlobalDatabase, type RefIndexDiffCounts } from "@folio/db";
import { TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Effect, type Option } from "effect";

// Maintenance facade for the global ref-index table. Not part of `oracleLayer`: it has no user, so the caller provides
// just this layer and the two ports.
// Runs in a Node script (GitHub Actions) over the D1 REST API, not in a Worker: the 2.6 MB fetch and tens of thousands of
// row diffs exceed the free plan's 10 ms CPU.
// Errors are surfaced, not degraded: there is no local stale value, and the caller must know the run was wasted.

// Service shape is derived from the `effect` return value; `.Default` is its layer.
export class GlobalRefIndexService extends Effect.Service<GlobalRefIndexService>()(
  "oracle/GlobalRefIndexService",
  {
    effect: Effect.gen(function* () {
      // Ops live in `GlobalDatabase` (the ticket with no owner).
      const { refIndex } = yield* GlobalDatabase;
      const upstream = yield* TokenUpstream;

      return {
        // Fetch, transform (in the adapter), replace everything at once; returns this run's accounting.
        warm: (): Effect.Effect<
          // Upstream stats (rows / mismatched / skipped) plus the diff of the write (changed / added / removed).
          {
            rows: number;
            unmatchedPlatforms: readonly string[];
            skipped: number;
          } & RefIndexDiffCounts,
          UpstreamError,
          DbClient
        > =>
          Effect.gen(function* () {
            const result = yield* upstream.fetchRefIndex();
            // A mismatch is a silent failure (that chain's tokens lose price and logo), so it must be reported.
            // Log goes through Effect's logger; the caller decides where it lands.
            if (result.unmatchedPlatforms.length > 0) {
              yield* Effect.logWarning(
                "global_token_ref_index: chain table mismatch, tokens on these chains will have no price or logo",
              ).pipe(
                Effect.annotateLogs({
                  namer: upstream.id,
                  platforms: result.unmatchedPlatforms,
                }),
              );
            }
            // Diff write: only changed rows are persisted; returns changed / added / removed counts for logging.
            const counts = yield* refIndex.putAll(result.rows, yield* Clock.currentTimeMillis);
            return {
              rows: result.rows.length,
              unmatchedPlatforms: result.unmatchedPlatforms,
              skipped: result.skipped,
              ...counts,
            };
          }),

        // Last successful refresh time of a source; `none` if never refreshed (first deploy needs a manual trigger).
        refreshedAt: (): Effect.Effect<Option.Option<number>, never, DbClient> =>
          refIndex.refreshedAt(upstream.id),
      };
    }),
  },
) {}
