import { Database, NotFound } from "@folio/db";
import type { AccountSyncResult } from "@folio/sync";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { isManual } from "@/lib/core/manual";
import { ConnectorRegistry } from "@/lib/server/connectors/registry";
import { isComplete, publicValues, readStoredCreds } from "@/lib/server/creds";
import { serverFn } from "@/lib/server/server-fn";
import { startAccountRound } from "./round";
import { isSyncableAccount, type SyncRoundView, syncRoundView } from "./status";

// Syncs one account by queueing it into a round and returning immediately. Only the non-network
// steps run here, inside the request's 10ms CPU: find the account, short-circuit known skips,
// queue.
export const SyncAccountInput = z.object({ accountId: z.string().min(1) });

/** `queued: false`: the outcome was known without queueing (manual, missing creds, archived). */
export type SyncAccountStart =
  | { queued: false; result: AccountSyncResult }
  | {
      queued: true;
      accountId: string;
      portfolioId: string;
      roundId: string;
      round: SyncRoundView;
    };

export const handleSyncAccount = serverFn("syncAccount")(function* (
  data: z.infer<typeof SyncAccountInput>,
) {
  const accounts = (yield* Database).accounts;
  const account = yield* accounts.getById(data.accountId);
  if (!account) return yield* Effect.fail(new NotFound({ entity: "account", id: data.accountId }));
  const done = (result: AccountSyncResult): SyncAccountStart => ({ queued: false, result });
  // Manual accounts have no upstream; report why so the UI can tell it apart from missing creds.
  if (isManual(account.connectorId)) {
    return done({ accountId: account.id, ok: false, skipped: true, skipReason: "manual" });
  }
  // Archived accounts never join a round.
  if (!isSyncableAccount(account)) return done({ accountId: account.id, ok: false, skipped: true });
  // Missing creds: answer now rather than spend a queued call to reach the same verdict.
  const connectors = yield* ConnectorRegistry;
  const specs = connectors.specs[account.connectorId] ?? [];
  const stored = readStoredCreds(yield* accounts.getRawCreds(account.id)) ?? {};
  const needed = connectors.neededCreds(account.connectorId, publicValues(specs, stored));
  if (!isComplete(specs, stored, needed)) {
    return done({
      accountId: account.id,
      ok: false,
      skipped: true,
      skipReason: "missing-credentials",
    });
  }
  const round = yield* startAccountRound({ id: account.id, label: account.label });
  return {
    queued: true,
    accountId: account.id,
    portfolioId: round.portfolioId,
    roundId: round.roundId,
    round: syncRoundView(round, yield* Clock.currentTimeMillis),
  } satisfies SyncAccountStart;
});
