import {
  Database,
  type DbRequest,
  type OpenSyncRoundResult,
  type SyncRoundAccountStatus,
  type SyncRoundRecord,
  type SyncRoundTrigger,
} from "@folio/db";
import { type AccountSyncResult, Sweep } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { Cause, Clock, Effect, Option } from "effect";
import { z } from "zod";
import { dataFreshness } from "@/lib/core/sync-status";
import {
  JOB_RETRY_MAX_DELAY_MS,
  SCHEDULING_SLACK_MS,
  SYNC_ATTEMPT_BUDGET_MS,
} from "@/lib/server/jobs/constants";
import type { SyncAccountJob } from "@/lib/server/jobs/message";
import { type Enqueued, enqueue } from "@/lib/server/jobs/queue";
import { hourlyUserJobs } from "@/lib/server/jobs/schedule";
import { scopedMembership } from "@/lib/server/portfolio/scope";
import { enqueueForUser, forUser, forUserDb, type UserJobs } from "@/lib/server/runtime";
import { serverFn } from "@/lib/server/server-fn";
import { makeSyncServices } from "./deps";
import { isSyncableAccount, type SyncRoundView, syncRoundView } from "./status";

// Server-side truth of a sync round: who's in it, what counts as alive, and how it reads.

/**
 * The only timeout knob. A round is alive until it expires; each settle and each consumer start
 * renews it, since no single task runs a round end to end. Derived from the retry chain: the
 * longest gap between renewals is one delivery + the longest backoff + slack (210s), so a round
 * isn't reported interrupted while retries remain. A runner backlog longer than
 * this still shows "interrupted" first; late settles carry the round id and still land.
 * Deliberately independent of roster size.
 */
export const ROUND_HEARTBEAT_MS =
  SYNC_ATTEMPT_BUDGET_MS + JOB_RETRY_MAX_DELAY_MS + SCHEDULING_SLACK_MS;

/** Retention after finish; the next round overwrites it anyway. */
export const ROUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fixes the roster (portfolio members ∧ active ∧ non-manual, same predicate as the header summary,
 * so the panel's `x / N` matches). Idempotent at the DB: a lost race returns the live round.
 */
export const openSyncRound = (input: {
  portfolioId?: string;
  trigger: SyncRoundTrigger;
}): Effect.Effect<OpenSyncRoundResult, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const { portfolioId, roster } = yield* rosterFor(input.portfolioId);
    return yield* db.syncRounds.open({
      portfolioId,
      roundId: crypto.randomUUID(),
      trigger: input.trigger,
      accounts: roster,
      ttlMs: ROUND_HEARTBEAT_MS,
    });
  });

const rosterFor = (
  portfolioId: string | undefined,
): Effect.Effect<
  { portfolioId: string; roster: { id: string; label: string }[] },
  never,
  Database | DbRequest
> =>
  Effect.gen(function* () {
    const scope = yield* scopedMembership(portfolioId);
    return {
      portfolioId: scope.selectedId,
      roster: scope.accounts
        .filter(isSyncableAccount)
        .filter((a) => scope.has(a.id))
        .map((a) => ({ id: a.id, label: a.label })),
    };
  });

/**
 * `skipped` here can only mean missing creds: manual accounts never enter a round. A new skip kind
 * would show as "needs keys" — change this line then.
 */
const statusOf = (r: AccountSyncResult): Exclude<SyncRoundAccountStatus, "pending"> =>
  r.ok ? "synced" : r.skipped ? "needs-keys" : "failed";

// Auto rounds settle accounts with fresh data as `skipped` and return the ids that still need the
// upstream. D1 only, no network. Manual rounds always run everything.
const planFreshSkips = (
  round: SyncRoundRecord,
  ids: readonly string[],
): Effect.Effect<Set<string>, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* Clock.currentTimeMillis;
    const latest = yield* db.snapshots.latest();
    const takenAtById = new Map(latest.map((s) => [s.snapshot.accountId, s.snapshot.takenAt]));
    const toRun = new Set<string>();
    for (const id of ids) {
      const takenAt = takenAtById.get(id) ?? null;
      // Same `dataFreshness` as the pill and the auto-sync trigger. Future timestamps (clock skew)
      // count as fresh rather than stale.
      if (dataFreshness(takenAt, now) === "fresh") {
        yield* db.syncRounds.settle({
          portfolioId: round.portfolioId,
          roundId: round.roundId,
          accountId: id,
          status: "skipped",
          ttlMs: ROUND_HEARTBEAT_MS,
        });
      } else {
        toRun.add(id);
      }
    }
    return toRun;
  });

const syncJobOf = (
  userId: string,
  round: Pick<SyncRoundRecord, "portfolioId" | "roundId">,
  accountId: string,
): SyncAccountJob => ({
  kind: "sync-account",
  userId,
  portfolioId: round.portfolioId,
  roundId: round.roundId,
  accountId,
});

const syncJobsOf = (
  userId: string,
  round: Pick<SyncRoundRecord, "portfolioId" | "roundId">,
  accountIds: Iterable<string>,
): Enqueued[] => Array.from(accountIds, (id) => ({ job: syncJobOf(userId, round, id) }));

const slotOf = (round: Pick<SyncRoundRecord, "portfolioId" | "roundId">) => ({
  portfolioId: round.portfolioId,
  roundId: round.roundId,
});

// Written into the round when enqueueing fails.
const ENQUEUE_FAILED = "could not queue the sync";

/**
 * Manual / auto round: opens a round, enqueues, returns — no upstream calls in this request (10ms
 * CPU covers waitUntil too). A live round is joined rather than overwritten: missing roster
 * accounts are enlisted and only they are queued. Auto rounds skip fresh accounts first; planning
 * failure falls back to a full round. With nothing to queue the round finishes now, or it would
 * read "interrupted" later; an enqueue failure finishes it with a reason before rethrowing.
 */
export const startSyncRound = (input: {
  portfolioId?: string;
  auto: boolean;
}): Effect.Effect<OpenSyncRoundResult, never, Database | DbRequest | UserJobs> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const { portfolioId, roster } = yield* rosterFor(input.portfolioId);
    const claim = yield* claimPortfolio(portfolioId, roster, "manual");
    if (claim.kind === "none") return { opened: false as const, round: claim.round };
    const round = claim.round;
    const head = slotOf(round);
    const allIds = new Set(claim.ids);
    const toRun: ReadonlySet<string> = input.auto
      ? yield* planFreshSkips(round, claim.ids).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "skip-fresh planning failed; running full round",
              Cause.pretty(cause),
            ).pipe(Effect.as(allIds)),
          ),
        )
      : allIds;
    if (toRun.size === 0) {
      yield* db.syncRounds.finishIfSettled({ ...head, retentionMs: ROUND_RETENTION_MS });
    } else {
      yield* enqueueForUser((userId) => [
        ...syncJobsOf(userId, round, toRun),
        ...hourlyUserJobs(userId),
      ]).pipe(Effect.tapCause(() => abandonClaims([{ ...claim, ids: [...toRun] }])));
    }
    const opened = claim.kind === "opened";
    // Our own full round with no skips is already current; otherwise re-read for the response.
    if (opened && !input.auto && toRun.size > 0) return { opened, round };
    const now = yield* db.syncRounds.get(round.portfolioId);
    const current = Option.getOrElse(
      Option.filter(now, (r) => r.roundId === round.roundId),
      () => round,
    );
    return { opened, round: current };
  });

/**
 * Single-account sync: open a one-account round, or enlist into the live one. Duplicate messages
 * are harmless since the consumer checks "still pending" first. A failed enlist (round finished
 * between calls) retries the open once, which must then succeed. Enqueue failure marks the account
 * failed.
 */
export const startAccountRound = (account: {
  id: string;
  label: string;
}): Effect.Effect<SyncRoundRecord, Error, Database | DbRequest | UserJobs> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const portfolioId = (yield* scopedMembership(undefined)).portfolioIdOf(account.id);
    const joinOrOpen = Effect.gen(function* () {
      const out = yield* db.syncRounds.open({
        portfolioId,
        roundId: crypto.randomUUID(),
        trigger: "manual",
        accounts: [account],
        ttlMs: ROUND_HEARTBEAT_MS,
      });
      if (out.opened) return Option.some(out.round);
      if (out.round == null) return Option.none<SyncRoundRecord>();
      return yield* db.syncRounds.enlist({
        portfolioId,
        roundId: out.round.roundId,
        account,
        ttlMs: ROUND_HEARTBEAT_MS,
      });
    });
    const first = yield* joinOrOpen;
    const round = Option.isSome(first) ? first : yield* joinOrOpen;
    if (Option.isNone(round)) return yield* Effect.fail(new Error("could not start a sync round"));
    const slot = { ...slotOf(round.value), accountId: account.id };
    yield* enqueueForUser((userId) => [
      { job: syncJobOf(userId, round.value, account.id) },
      ...hourlyUserJobs(userId),
    ]).pipe(Effect.tapCause(() => settleQueued(slot, { status: "failed", error: ENQUEUE_FAILED })));
    return round.value;
  });

/** `opened`: our round, queue all. `joined`: enlisted into a live round, queue only those. */
type Claim =
  | { kind: "opened" | "joined"; round: SyncRoundRecord; ids: string[] }
  | { kind: "none"; round: SyncRoundRecord | null };

type Queued = Extract<Claim, { ids: string[] }>;

/**
 * Opens a round, or enlists roster accounts missing from the live one (which may be a one-account
 * round). Accounts already in it are left alone. A failed first enlist means the round just ended,
 * so retry the open once. If enlisting throws midway, already-enlisted accounts are marked failed.
 */
const claimPortfolio = (
  portfolioId: string,
  roster: readonly { id: string; label: string }[],
  trigger: SyncRoundTrigger,
): Effect.Effect<Claim, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const openIt = db.syncRounds.open({
      portfolioId,
      roundId: crypto.randomUUID(),
      trigger,
      accounts: roster,
      ttlMs: ROUND_HEARTBEAT_MS,
    });
    let live: SyncRoundRecord | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = yield* openIt;
      if (out.opened) {
        return { kind: "opened", round: out.round, ids: Object.keys(out.round.accounts) };
      }
      if (out.round == null) return { kind: "none", round: null };
      const round = out.round;
      live = round;
      const missing = roster.filter((a) => round.accounts[a.id] === undefined);
      if (missing.length === 0) return { kind: "none", round };
      const ids: string[] = [];
      const enlistAll = Effect.gen(function* () {
        for (const account of missing) {
          const got = yield* db.syncRounds.enlist({
            portfolioId,
            roundId: round.roundId,
            account,
            ttlMs: ROUND_HEARTBEAT_MS,
          });
          if (Option.isNone(got)) return;
          ids.push(account.id);
        }
      });
      yield* enlistAll.pipe(Effect.tapCause(() => abandonClaims([{ kind: "joined", round, ids }])));
      if (ids.length > 0) return { kind: "joined", round, ids };
    }
    return { kind: "none", round: live };
  });

/**
 * Claimed but not queued: finish our own rounds with a reason and fail enlisted accounts, so they
 * don't sit pending until expiry. Best-effort.
 */
const abandonClaims = (
  claims: readonly Queued[],
): Effect.Effect<void, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* Effect.forEach(claims, (claim) =>
      claim.kind === "opened"
        ? db.syncRounds.finish({
            ...slotOf(claim.round),
            error: ENQUEUE_FAILED,
            retentionMs: ROUND_RETENTION_MS,
          })
        : Effect.forEach(claim.ids, (accountId) =>
            settleQueued(
              { ...slotOf(claim.round), accountId },
              { status: "failed", error: ENQUEUE_FAILED },
            ),
          ),
    );
  }).pipe(Effect.catchCause(() => Effect.void));

/**
 * Cron, per user: one round per portfolio; only opens rounds and enqueues, no network (running
 * everything in the cron invocation exceeded CPU). Each account belongs to exactly one portfolio,
 * so each settle writes one key. Empty rounds finish immediately; failures abandon claims first.
 */
const fanOutUserRounds = (userId: string): Effect.Effect<Enqueued[], Error> =>
  Effect.gen(function* () {
    const db = yield* Database;
    // One read, one partition: per-portfolio reads would cost P queries and could put an account
    // in two rounds (or none) if it moves mid-loop. Unassigned accounts fall back to the default.
    const defaultPf = yield* db.portfolios.ensureDefault();
    const [portfolios, memberships, accounts] = yield* Effect.all(
      [db.portfolios.list(), db.portfolios.listMemberships(), db.accounts.list()],
      { concurrency: 3 },
    );
    const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
    const rosters = new Map<string, { id: string; label: string }[]>(
      portfolios.map((pf) => [pf.id, []]),
    );
    for (const a of accounts.filter(isSyncableAccount)) {
      const home = portfolioOf.get(a.id) ?? defaultPf.id;
      // Can't happen under FK cascade; if it does, skip rather than open a round nobody reads.
      rosters.get(home)?.push({ id: a.id, label: a.label });
    }
    // Cleanup covers the whole block: a failure opening portfolio k+1 must also release 1..k.
    const toQueue: Queued[] = [];
    const claimAndQueue = Effect.gen(function* () {
      for (const pf of portfolios) {
        const claim = yield* claimPortfolio(pf.id, rosters.get(pf.id) ?? [], "cron");
        if (claim.kind === "none") continue;
        if (claim.ids.length === 0) {
          yield* db.syncRounds.finish({ ...slotOf(claim.round), retentionMs: ROUND_RETENTION_MS });
        } else {
          toQueue.push(claim);
        }
      }
      const batch: Enqueued[] = [
        ...toQueue.flatMap((claim) => syncJobsOf(userId, claim.round, claim.ids)),
        ...hourlyUserJobs(userId),
      ];
      yield* enqueue(batch);
      return batch;
    });
    const batch = yield* claimAndQueue.pipe(Effect.tapCause(() => abandonClaims(toQueue)));
    return batch;
  }).pipe((work) => forUserDb(userId, work));

/** Cron pass tally; sync outcomes aren't known yet. */
export interface FanOutResult {
  users: number;
  accounts: number;
  failed: number;
  jobs: number;
  /** Lower bound on runner alarms (one per job; retries add more). */
  alarms: number;
}

/**
 * Cron sweep, serial per user. `prices` and `sync-account` are queued together without ordering:
 * delaying sync for fresher snapshot values isn't worth the visible delay. Each user is isolated at
 * the Cause level (failures are defects), so one bad user can't block the rest; logs omit userId.
 * `fanOutOne` is injectable for tests.
 */
export const fanOutAllUsers = (
  userIds: readonly string[],
  fanOutOne: (userId: string) => Effect.Effect<Enqueued[], Error> = fanOutUserRounds,
): Effect.Effect<FanOutResult> =>
  Effect.forEach(userIds, (userId) =>
    fanOutOne(userId).pipe(
      Effect.map((batch) => ({
        accounts: batch.filter((m) => m.job.kind === "sync-account").length,
        failed: 0,
        jobs: batch.length,
      })),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          getLogger(["folio", "cron"]).warn("user fan-out failed, user skipped", {
            error: Cause.pretty(cause),
          });
          return { accounts: 0, failed: 1, jobs: 0 };
        }),
      ),
    ),
  ).pipe(
    Effect.map((per) => ({
      users: userIds.length,
      accounts: per.reduce((n, p) => n + p.accounts, 0),
      failed: per.reduce((n, p) => n + p.failed, 0),
      jobs: per.reduce((n, p) => n + p.jobs, 0),
      alarms: per.reduce((n, p) => n + p.jobs, 0),
    })),
  );

// Still worth running? Same round on the key, not finished, account still pending. Delivery is
// at-least-once and a manual round may have replaced the key.
const stillPending = (round: Option.Option<SyncRoundRecord>, job: SyncAccountJob): boolean =>
  Option.exists(
    round,
    (r) =>
      r.roundId === job.roundId &&
      r.finishedAt === null &&
      r.accounts[job.accountId]?.status === "pending",
  );

/**
 * Settles one account and finishes the round if it was the last (a conditional UPDATE, so only one
 * concurrent consumer wins). The finisher logs the tally.
 */
const settleQueued = (
  job: Pick<SyncAccountJob, "portfolioId" | "roundId" | "accountId">,
  outcome: { status: Exclude<SyncRoundAccountStatus, "pending">; error?: string },
): Effect.Effect<void, never, Database | DbRequest> =>
  Effect.gen(function* () {
    const db = yield* Database;
    const head = { portfolioId: job.portfolioId, roundId: job.roundId };
    yield* db.syncRounds.settle({
      ...head,
      accountId: job.accountId,
      ...outcome,
      ttlMs: ROUND_HEARTBEAT_MS,
    });
    const finished = yield* db.syncRounds.finishIfSettled({
      ...head,
      retentionMs: ROUND_RETENTION_MS,
    });
    if (Option.isNone(finished)) return;
    const view = syncRoundView(finished.value, yield* Clock.currentTimeMillis);
    getLogger(["folio", "jobs"]).info("queued round done", {
      portfolioId: job.portfolioId,
      trigger: finished.value.trigger,
      state: view.state,
      total: view.total,
      synced: view.synced,
      failed: view.failed.length,
      needsKeys: view.needsKeys,
      unresolved: view.unresolved,
    });
  });

/**
 * Consumer for `sync-account`: same sync core as manual rounds, restricted to one account. An
 * account gone from the roster settles as `skipped`. Per-account failures settle in the core; only
 * defects or `SyncDepError` reach the runner's retry.
 */
export const syncQueuedAccount = (job: SyncAccountJob): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (!stillPending(yield* db.syncRounds.get(job.portfolioId), job)) {
      getLogger(["folio", "jobs"]).info("stale sync job skipped", { accountId: job.accountId });
      return;
    }
    // Renew before each run: retries have no settles in between, so the round would expire first.
    yield* db.syncRounds.touch({ ...slotOf(job), ttlMs: ROUND_HEARTBEAT_MS });
    // Context instead of a Layer, and no Stream, to save per-message setup cost.
    const services = yield* makeSyncServices({ only: new Set([job.accountId]) });
    const result = yield* Sweep.syncOne(job.userId, job.accountId).pipe(Effect.provide(services));
    yield* settleQueued(
      job,
      Option.match(result, {
        onNone: () => ({ status: "skipped" as const }),
        onSome: (r) => ({
          status: statusOf(r),
          // Keep the upstream message only for real failures.
          error: r.ok || r.skipped ? undefined : r.error,
        }),
      }),
    );
  }).pipe((work) => forUser(job.userId, work));

/** Final delivery failed: mark the account failed so the round doesn't stay pending. */
export const giveUpQueuedAccount = (
  job: SyncAccountJob,
  reason: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (!stillPending(yield* db.syncRounds.get(job.portfolioId), job)) return;
    yield* settleQueued(job, { status: "failed", error: reason });
  }).pipe((work) => forUser(job.userId, work));

// The selection lives only on the client.
export const GetSyncRoundInput = z.object({ portfolioId: z.string().min(1) });

/** `null` when there was never a round: "never synced" reads differently from "just started". */
export const handleGetSyncRound = serverFn("getSyncRound")(function* (
  data: z.infer<typeof GetSyncRoundInput>,
) {
  const db = yield* Database;
  // Read the key directly, skipping portfolio resolution on this 1.5s poll. The key is user-scoped,
  // so an unknown id just reads empty.
  const round = yield* db.syncRounds.get(data.portfolioId);
  const now = yield* Clock.currentTimeMillis;
  return Option.match(round, {
    onNone: () => null,
    onSome: (r): SyncRoundView | null => syncRoundView(r, now),
  });
});
