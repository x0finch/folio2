import type { QueryClient } from "@tanstack/react-query";
import { SYNC_RETRY_CHAIN_MS } from "@/lib/server/jobs/constants";
import { syncAccount } from "@/lib/server/sync";
import type { SyncAccountStart } from "@/lib/server/sync/run";
import type { SyncRoundView } from "@/lib/server/sync/status";
import { POLL_INTERVAL } from "./constants";
import { syncKeys } from "./keys";
import { syncRoundQuery } from "./sync-round";

// `syncAccount` only enqueues the account into its portfolio's round (doing the work inline would
// blow the 10ms CPU budget), so the result is read back from that round. The outcome shape matches
// the old inline result, so callers' toast branches are unchanged.

export type AccountSyncOutcome = Extract<SyncAccountStart, { queued: false }>["result"];

/** Slack for queue dispatch and polling on top of the retry chain's worst case. */
const ACCOUNT_SYNC_TIMEOUT_MARGIN_MS = 60_000;

/**
 * Must exceed the whole server retry chain (~560s): otherwise the client gives up with a generic
 * error before the server settles the account. Beyond this the job is stuck; stop waiting.
 */
export const ACCOUNT_SYNC_TIMEOUT_MS = SYNC_RETRY_CHAIN_MS + ACCOUNT_SYNC_TIMEOUT_MARGIN_MS;

/**
 * `null` = not settled yet. A missing or replaced round → skipped (results were overwritten, data
 * is stored). Interrupted before its turn → failed. Still pending after the round finished → skipped
 * (archived or deleted mid-round).
 */
export function accountOutcomeIn(
  view: SyncRoundView | null,
  roundId: string,
  accountId: string,
): AccountSyncOutcome | null {
  if (view == null || view.roundId !== roundId) return { accountId, ok: false, skipped: true };
  switch (view.statuses[accountId]) {
    case "synced":
      return { accountId, ok: true };
    case "needs-keys":
      return { accountId, ok: false, skipped: true, skipReason: "missing-credentials" };
    case "skipped":
      return { accountId, ok: false, skipped: true };
    case "failed":
      return {
        accountId,
        ok: false,
        error: view.failed.find((f) => f.accountId === accountId)?.error,
      };
    default:
      if (view.state === "running") return null;
      if (view.state === "interrupted") return { accountId, ok: false };
      return { accountId, ok: false, skipped: true };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Seeds the round cache with the start response (cancelling the in-flight read first) so the header
 * pill starts at once. Rejects only if starting fails; a failed sync is `ok: false`.
 */
export async function syncAccountAndWait(
  queryClient: QueryClient,
  accountId: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<AccountSyncOutcome> {
  const start = await syncAccount({ data: { accountId } });
  if (!start.queued) return start.result;
  const { portfolioId, roundId } = start;
  await queryClient.cancelQueries({ queryKey: syncKeys.round(portfolioId) });
  queryClient.setQueryData(syncKeys.round(portfolioId), start.round);

  const pollMs = opts.pollMs ?? POLL_INTERVAL.syncRound;
  const deadline = Date.now() + (opts.timeoutMs ?? ACCOUNT_SYNC_TIMEOUT_MS);
  let view: SyncRoundView | null = start.round;
  for (;;) {
    const outcome = accountOutcomeIn(view, roundId, accountId);
    if (outcome) return outcome;
    if (Date.now() >= deadline) return { accountId, ok: false };
    await sleep(pollMs);
    view = await queryClient.fetchQuery({ ...syncRoundQuery(portfolioId), staleTime: 0 });
  }
}
