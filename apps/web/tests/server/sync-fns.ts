import type { Balance } from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import { Account, type AccountSyncResult, BalanceSource } from "@folio/sync";
import type { UpstreamError } from "@folio/upstream-basic";
import { Effect, Layer } from "effect";
import { runForUser } from "@/lib/server/runtime";
import { makeSyncServicesLayer } from "@/lib/server/sync/deps";
import { runReferenceJob } from "@/lib/server/sync/reference";

// Only balance fetching is swapped (the one step that goes out to the network); accounts, snapshots,
// token minting and revaluation use the real wiring and real D1.

export interface SyncJob {
  account: AccountSafe;
  rawCreds?: string | null;
  balances?: Balance[];
  fail?: UpstreamError;
}

const sourceFor = (job: SyncJob) =>
  Layer.succeed(BalanceSource, {
    fetch: () =>
      job.fail
        ? Effect.fail(job.fail)
        : Effect.succeed({
            status: "ok" as const,
            balances: job.balances ?? [],
            totalUsd: (job.balances ?? []).reduce((sum, b) => sum + b.value, 0),
          }),
  });

/** One sync round: several accounts share one assembly, run serially like the cron sweep. */
export const syncRound = (userId: string, jobs: SyncJob[]): Promise<AccountSyncResult[]> =>
  runForUser(
    userId,
    Effect.forEach(jobs, (job) =>
      Account.syncAccount(userId, job.account, job.rawCreds ?? null).pipe(
        Effect.provide(sourceFor(job)),
      ),
    ).pipe(Effect.provide(makeSyncServicesLayer())),
  );

export const syncOne = async (userId: string, job: SyncJob): Promise<AccountSyncResult> => {
  const [result] = await syncRound(userId, [job]);
  return result;
};

/** Runs one `catalogue` job through the same consumer production uses. */
export const refreshCatalogueFor = (userId: string): Promise<void> =>
  Effect.runPromise(runReferenceJob({ kind: "catalogue", userId }));
