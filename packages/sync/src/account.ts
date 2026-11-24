import type { Balance } from "@folio/connectors-basic";
import { ConnectorFailure } from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import { Effect } from "effect";
import { messageOf, type SyncDepError } from "./errors";
import { platformOf } from "./platform";
import { fetchBalancesWithRetry } from "./retry";
import { SnapshotStore, type SyncServices, TokenOracle } from "./services";
import type { AccountSyncResult, OkOutcome } from "./types";

// Errors never escape: a failed account becomes ok:false so other accounts continue.

// Best-effort step: log a warning and fall back; recognise and revalue degrade independently.
const bestEffort = <A>(
  effect: Effect.Effect<A, SyncDepError, SyncServices>,
  fallback: A,
  message: string,
): Effect.Effect<A, never, SyncServices> =>
  effect.pipe(
    Effect.catch((e) =>
      Effect.logWarning(message).pipe(Effect.annotateLogs("error", e.message), Effect.as(fallback)),
    ),
  );

// Balance contract uses `value`; the snapshot layer keeps the `usdValue` column.
const toSnapshotRows = (
  balances: Balance[],
  connectorId: string,
  idByRef: ReadonlyMap<string, string>,
) =>
  balances.map((b) => ({
    amount: b.amount,
    usdValue: b.value,
    kind: b.kind,
    // Platform is computed once at write time; readers only read the column.
    platform: platformOf(b.tokenRef, connectorId),
    selfPrice: b.selfPrice,
    // Mint answer frozen into the snapshot (the same one used for revaluation).
    tokenId: b.tokenRef ? idByRef.get(b.tokenRef) : undefined,
    // meta exists only on defi/perp kinds; narrow with `in`.
    meta: "meta" in b ? b.meta : undefined,
    note: b.note,
  }));

const finish = (account: AccountSafe, outcome: OkOutcome) =>
  Effect.gen(function* () {
    const oracle = yield* TokenOracle;
    const snapshotStore = yield* SnapshotStore;
    // Recognition runs once per round; its answer feeds both revaluation and the snapshot.
    const idByRef = yield* bestEffort(
      oracle.mint(outcome.balances),
      new Map<string, string>() as ReadonlyMap<string, string>,
      "mint failed; writing snapshot without token_id",
    );
    // null = not revalued (not injected, or failed).
    const revalued = yield* bestEffort<Balance[] | null>(
      oracle.revalue(account.connectorId, outcome.balances, idByRef),
      null,
      "revalue failed; keeping provider values",
    );
    const balances = revalued ?? outcome.balances;
    // Recompute totalUsd only after a real revaluation; the provider's total need not equal the row sum.
    const totalUsd = revalued ? revalued.reduce((sum, b) => sum + b.value, 0) : outcome.totalUsd;
    const snapshotId = yield* snapshotStore.write(account.id, {
      takenAt: Date.now(),
      totalUsd,
      note: outcome.note,
      balances: toSnapshotRows(balances, account.connectorId, idByRef),
    });
    yield* Effect.logInfo("account synced").pipe(
      Effect.annotateLogs({ totalUsd, balances: balances.length }),
    );
    return { accountId: account.id, ok: true, snapshotId, totalUsd } satisfies AccountSyncResult;
  });

// `userId` is for log annotation only.
export const syncAccount = (
  userId: string,
  account: AccountSafe,
  rawCreds: string | null, // prefetched per user in syncUser
): Effect.Effect<AccountSyncResult, never, SyncServices> =>
  Effect.gen(function* () {
    const stored = yield* Effect.try({
      try: (): Record<string, string> => (rawCreds ? JSON.parse(rawCreds) : {}),
      // Bad JSON can't be fixed by retrying: classify as non-retryable.
      catch: (e) => new ConnectorFailure({ message: messageOf(e), cause: e }),
    });
    const outcome = yield* fetchBalancesWithRetry(account, stored);
    // Missing credentials: skipped, neither a failure nor an error-channel value.
    if (outcome.status === "needs-credentials") {
      yield* Effect.logWarning("account sync skipped: needs credentials");
      return {
        accountId: account.id,
        ok: false,
        skipped: true,
        skipReason: "missing-credentials",
      } satisfies AccountSyncResult;
    }
    return yield* finish(account, outcome);
  }).pipe(
    Effect.catch((err) =>
      Effect.logError("account sync failed").pipe(
        Effect.annotateLogs({
          reason: err._tag,
          error: err.message,
        }),
        Effect.as({
          accountId: account.id,
          ok: false,
          error: err.message,
        } satisfies AccountSyncResult),
      ),
    ),
    // Annotated once for the whole account, retry warnings included; cron has no request context, so userId is explicit. Never log creds or addresses.
    Effect.annotateLogs({
      userId,
      accountId: account.id,
      connectorId: account.connectorId,
    }),
  );
