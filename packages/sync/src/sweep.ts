import { Effect, Option, Stream } from "effect";
import { syncAccount } from "./account";
import { SYNC_CONCURRENCY } from "./constants";
import type { SyncDepError } from "./errors";
import { AccountStore, type SyncServices } from "./services";
import type { AccountSyncResult, SyncResult } from "./types";

// `unordered: true`: emit as each account finishes so progress doesn't stall behind slow accounts; callers must match by accountId, not index.
//
// A failure listing accounts or creds means the user's round can't start, so it propagates instead of becoming ok:false.
export const syncUserStream = (
  userId: string,
): Stream.Stream<AccountSyncResult, SyncDepError, SyncServices> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* AccountStore;
      // The two reads are independent: run concurrently.
      const [accounts, rawList] = yield* Effect.all([store.list(), store.rawCreds()], {
        concurrency: 2,
      });
      const credsById = new Map(rawList.map((r) => [r.id, r.creds]));
      // Bounded concurrency. Keep the whole chain in one Effect/Stream: runPromise in between would cut context and the fake clock couldn't drive backoff.
      return Stream.fromIterable(accounts).pipe(
        Stream.mapEffect(
          (account) => syncAccount(userId, account, credsById.get(account.id) ?? null),
          { concurrency: SYNC_CONCURRENCY, unordered: true },
        ),
      );
    }),
  );

export const syncUser = (userId: string): Effect.Effect<SyncResult, SyncDepError, SyncServices> =>
  syncUserStream(userId).pipe(
    Stream.runCollect,
    Effect.map((results) => ({ results })),
  );

// Syncs a single account (one queue message each) without the Stream machinery, which costs real CPU in a 10ms budget. `none` if the account isn't listed.
export const syncOne = (
  userId: string,
  accountId: string,
): Effect.Effect<Option.Option<AccountSyncResult>, SyncDepError, SyncServices> =>
  Effect.gen(function* () {
    const store = yield* AccountStore;
    const [accounts, rawList] = yield* Effect.all([store.list(), store.rawCreds()], {
      concurrency: 2,
    });
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return Option.none();
    const creds = rawList.find((r) => r.id === accountId)?.creds ?? null;
    return Option.some(yield* syncAccount(userId, account, creds));
  });
