import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import type { SyncRoundRecord } from "../src/domains/sync-rounds";
import { user } from "../src/schema/auth";
import { forDomain, NOW } from "./effect";

// Runs against real D1: correctness lives in SQL (conditional upsert `WHERE`, `json_set` paths, a mismatched round id falling through).

const rounds = forDomain((db) => db.syncRounds);

const USER_A = "user-a";
const USER_B = "user-b";
const PF = "pf-1";
const TTL = 120_000;
const RETENTION = 7 * 24 * 60 * 60 * 1000;

/** Writes a raw value straight onto the key; a "bad value blocks opening a round" case can only be built by bypassing the store. */
async function seedRawValue(userId: string, v: string, expiresAt: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user_cache (user_id, k, v, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at",
  )
    .bind(userId, `sync-round:${PF}`, v, expiresAt)
    .run();
}

async function resetUser(userId: string): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetUser(USER_A);
  await resetUser(USER_B);
});

const ACCOUNTS = [
  { id: "acc-1", label: "Binance spot" },
  { id: "acc-2", label: "Kraken" },
];

// Non-null on the assertion side: these cases can't build a row deleted between two statements, so open's null branch is unreachable here.
const open = async (
  userId: string,
  roundId: string,
  nowMs = NOW,
  over: { portfolioId?: string; trigger?: "manual" | "cron" } = {},
) => {
  const out = await rounds(userId, nowMs).open({
    portfolioId: over.portfolioId ?? PF,
    roundId,
    trigger: over.trigger ?? "manual",
    accounts: ACCOUNTS,
    ttlMs: TTL,
  });
  if (out.round == null) throw new Error("open returned no round — the row vanished mid-test?");
  return { opened: out.opened, round: out.round };
};

const read = async (userId: string, nowMs = NOW, portfolioId = PF): Promise<SyncRoundRecord> => {
  const got = await rounds(userId, nowMs).get(portfolioId);
  if (Option.isNone(got)) throw new Error("expected a round");
  return got.value;
};

describe("open round", () => {
  it("writes the round header and per-account detail; heartbeat expiry = now + ttl", async () => {
    const { round, opened } = await open(USER_A, "r1");
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r1");
    expect(round.trigger).toBe("manual");
    expect(round.startedAt).toBe(NOW);
    expect(round.finishedAt).toBeNull();
    expect(round.expiresAt).toBe(NOW + TTL);
    expect(round.accounts).toEqual({
      "acc-1": { label: "Binance spot", status: "pending" },
      "acc-2": { label: "Kraken", status: "pending" },
    });
    expect(await read(USER_A)).toEqual(round);
  });

  // Idempotent: a second device (or cron racing a manual run) sees the same round, not a fresh one that wipes the detail.
  it("a live round returns the same round without overwriting", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 1).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-1",
      status: "synced",
      ttlMs: TTL,
    });

    const { round, opened } = await open(USER_A, "r2", NOW + 2);
    expect(opened).toBe(false);
    expect(round.roundId).toBe("r1");
    expect(round.accounts["acc-1"]?.status).toBe("synced");
  });

  it("a finished previous round is replaced by a new one", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 1).finish({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });

    const { round, opened } = await open(USER_A, "r2", NOW + 2);
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r2");
    expect(round.accounts["acc-1"]?.status).toBe("pending");
  });

  // Unfinished with a dead heartbeat means the worker died; otherwise that portfolio could never open a round again.
  it("an unfinished but expired previous round is replaced", async () => {
    await open(USER_A, "r1");
    const { round, opened } = await open(USER_A, "r2", NOW + TTL + 1);
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r2");
    expect(round.expiresAt).toBe(NOW + TTL + 1 + TTL);
  });

  // `expiresAt` means "alive until this instant": now == expiresAt counts as expired (same `<=` as cache staleness). Asserts exact values, not wall clock.
  it("the exact expiry instant counts as expired", async () => {
    await open(USER_A, "r1");
    const { opened } = await open(USER_A, "r2", NOW + TTL);
    expect(opened).toBe(true);
  });

  it("one key per portfolio; another portfolio's round is independent", async () => {
    await open(USER_A, "r1");
    const { round, opened } = await open(USER_A, "r2", NOW, { portfolioId: "pf-2" });
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r2");
    expect((await read(USER_A)).roundId).toBe("r1");
  });

  it("isolated per user: B opening a round leaves A's key alone", async () => {
    await open(USER_A, "r1");
    await open(USER_B, "r2");
    expect((await read(USER_A)).roundId).toBe("r1");
    expect((await read(USER_B)).roundId).toBe("r2");
  });
});

describe("read round", () => {
  it("none when never opened", async () => {
    expect(Option.isNone(await rounds(USER_A).get(PF))).toBe(true);
  });

  it("bad JSON on the key reads as none, and the next open overwrites it", async () => {
    await seedRawValue(USER_A, "not-json{{{", NOW + TTL);
    expect(Option.isNone(await rounds(USER_A).get(PF))).toBe(true);

    // A bad value (unfinished, unexpired) would otherwise block this portfolio's sync forever, so open's setWhere must accept it.
    const { opened, round } = await open(USER_A, "r-recover");
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r-recover");
  });

  it("valid JSON that is not a round (no roundId) is treated like a bad value", async () => {
    await seedRawValue(USER_A, JSON.stringify({ hello: "world" }), NOW + TTL);
    expect(Option.isNone(await rounds(USER_A).get(PF))).toBe(true);
    const { opened } = await open(USER_A, "r-recover");
    expect(opened).toBe(true);
  });
});

describe("per-account result", () => {
  it("stores the status and the original error text, and renews the heartbeat to now + ttl", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-2",
      status: "failed",
      error: "401 from upstream",
      ttlMs: TTL,
    });

    const round = await read(USER_A);
    expect(round.accounts["acc-2"]).toEqual({
      label: "Kraken",
      status: "failed",
      error: "401 from upstream",
    });
    expect(round.accounts["acc-1"]?.status).toBe("pending");
    expect(round.expiresAt).toBe(NOW + 5 + TTL);
  });

  it("needs-credentials is a result, not a failure", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-1",
      status: "needs-keys",
      ttlMs: TTL,
    });
    expect((await read(USER_A)).accounts["acc-1"]?.status).toBe("needs-keys");
  });

  // Race: an old round's worker is still running while the key holds a new round; the round-id-conditioned statement no-ops instead of corrupting the new detail.
  it("a mismatched round id is a no-op", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "STALE",
      accountId: "acc-1",
      status: "synced",
      ttlMs: TTL,
    });

    const round = await read(USER_A);
    expect(round.accounts["acc-1"]?.status).toBe("pending");
    // The stale worker must not renew the heartbeat either, or a dead round would look alive forever.
    expect(round.expiresAt).toBe(NOW + TTL);
  });

  it("an unknown accountId does not add a detail entry", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "ghost",
      status: "synced",
      ttlMs: TTL,
    });
    expect(Object.keys((await read(USER_A)).accounts).sort()).toEqual(["acc-1", "acc-2"]);
  });

  // Two messages for one account racing past the consumer's pending check (at-least-once redelivery): the first settle counts, the later one doesn't rewrite it.
  it("an already settled account: a second settle is a no-op and keeps status and text", async () => {
    await open(USER_A, "r1");
    const settle = (at: number, status: "synced" | "failed", error?: string) =>
      rounds(USER_A, at).settle({
        portfolioId: PF,
        roundId: "r1",
        accountId: "acc-1",
        status,
        error,
        ttlMs: TTL,
      });
    await settle(NOW + 1, "synced");
    await settle(NOW + 2, "failed", "flake");
    const round = await read(USER_A);
    expect(round.accounts["acc-1"]).toEqual({ label: "Binance spot", status: "synced" });
    expect(round.expiresAt).toBe(NOW + 1 + TTL);
  });

  // Finishing writes the final report with a 7-day retention; a late settle that still matched would alter it and reset retention to 120s.
  it("a finished round: settle is a no-op, report and retention untouched", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 1).finish({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });
    await rounds(USER_A, NOW + 2).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-1",
      status: "failed",
      error: "late",
      ttlMs: TTL,
    });
    const round = await read(USER_A);
    expect(round.accounts["acc-1"]?.status).toBe("pending");
    expect(round.expiresAt).toBe(NOW + 1 + RETENTION);
  });
});

describe("heartbeat renewal (touch)", () => {
  // A keepalive renews it while the round lives; a queued round has no settles and would be mistaken for dead and overwritten.
  it("renews to now + ttl", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 60_000).touch({ portfolioId: PF, roundId: "r1", ttlMs: TTL });
    expect((await read(USER_A)).expiresAt).toBe(NOW + 60_000 + TTL);
  });

  it("a mismatched round id is a no-op", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 60_000).touch({ portfolioId: PF, roundId: "STALE", ttlMs: TTL });
    expect((await read(USER_A)).expiresAt).toBe(NOW + TTL);
  });

  // Keepalive and finish race: a late touch must not shorten the 7-day retention back to 120s.
  it("a finished round is not renewed: retention isn't shortened by a late heartbeat", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 1).finish({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });
    await rounds(USER_A, NOW + 2).touch({ portfolioId: PF, roundId: "r1", ttlMs: TTL });
    expect((await read(USER_A)).expiresAt).toBe(NOW + 1 + RETENTION);
  });
});

describe("finish", () => {
  it("sets finishedAt and extends retention", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 9).finish({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });

    const round = await read(USER_A);
    expect(round.finishedAt).toBe(NOW + 9);
    expect(round.expiresAt).toBe(NOW + 9 + RETENTION);
  });

  // A whole-round failure (listing accounts / creds) has no per-account result, so the message goes on the header.
  it("a whole-round failure message sits on the header, not in the per-account detail", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 9).finish({
      portfolioId: PF,
      roundId: "r1",
      error: "account store exploded",
      retentionMs: RETENTION,
    });

    const round = await read(USER_A);
    expect(round.error).toBe("account store exploded");
    expect(round.accounts["acc-1"]?.status).toBe("pending");
  });

  it("a mismatched round id is a no-op", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 9).finish({
      portfolioId: PF,
      roundId: "STALE",
      retentionMs: RETENTION,
    });
    expect((await read(USER_A)).finishedAt).toBeNull();
  });
});

// Queue path: one message per account and no task runs start to finish, so the last settler finishes the round.
describe("finish when settled (finishIfSettled)", () => {
  const settle = (accountId: string, at: number) =>
    rounds(USER_A, at).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId,
      status: "synced",
      ttlMs: TTL,
    });
  const finishIfSettled = (at: number, roundId = "r1") =>
    rounds(USER_A, at).finishIfSettled({ portfolioId: PF, roundId, retentionMs: RETENTION });

  it("does not finish while any account is pending", async () => {
    await open(USER_A, "r1");
    await settle("acc-1", NOW + 1);
    expect(Option.isNone(await finishIfSettled(NOW + 2))).toBe(true);
    expect((await read(USER_A)).finishedAt).toBeNull();
  });

  it("the last settler finishes the round, extends retention, and returns the finished round", async () => {
    await open(USER_A, "r1");
    await settle("acc-1", NOW + 1);
    await settle("acc-2", NOW + 2);
    const got = await finishIfSettled(NOW + 3);
    expect(Option.getOrNull(got)?.finishedAt).toBe(NOW + 3);
    const round = await read(USER_A);
    expect(round.finishedAt).toBe(NOW + 3);
    expect(round.expiresAt).toBe(NOW + 3 + RETENTION);
  });

  // Two consumers each call it after settling: only one wins, and the finish time isn't rewritten.
  it("already finished: a second call is a no-op", async () => {
    await open(USER_A, "r1");
    await settle("acc-1", NOW + 1);
    await settle("acc-2", NOW + 2);
    await finishIfSettled(NOW + 3);
    expect(Option.isNone(await finishIfSettled(NOW + 4))).toBe(true);
    expect((await read(USER_A)).finishedAt).toBe(NOW + 3);
  });

  it("a mismatched round id is a no-op", async () => {
    await open(USER_A, "r1");
    await settle("acc-1", NOW + 1);
    await settle("acc-2", NOW + 2);
    expect(Option.isNone(await finishIfSettled(NOW + 3, "STALE"))).toBe(true);
    expect((await read(USER_A)).finishedAt).toBeNull();
  });
});

describe("enlist into a live round (enlist)", () => {
  const enlist = (at: number, id: string, roundId = "r1") =>
    rounds(USER_A, at).enlist({
      portfolioId: PF,
      roundId,
      account: { id, label: `label ${id}` },
      ttlMs: TTL,
    });

  it("an account not on the list is added as pending and renews the heartbeat; finishIfSettled waits for it", async () => {
    await open(USER_A, "r1");
    const got = await enlist(NOW + 5, "acc-3");
    expect(Option.getOrNull(got)?.accounts["acc-3"]).toEqual({
      label: "label acc-3",
      status: "pending",
    });
    const round = await read(USER_A);
    expect(round.expiresAt).toBe(NOW + 5 + TTL);
    for (const id of ["acc-1", "acc-2"]) {
      await rounds(USER_A, NOW + 6).settle({
        portfolioId: PF,
        roundId: "r1",
        accountId: id,
        status: "synced",
        ttlMs: TTL,
      });
    }
    const fin = await rounds(USER_A, NOW + 7).finishIfSettled({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });
    expect(Option.isNone(fin)).toBe(true);
  });

  it("an already settled account goes back to pending (sync again)", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 1).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-1",
      status: "failed",
      error: "boom",
      ttlMs: TTL,
    });
    await enlist(NOW + 2, "acc-1");
    expect((await read(USER_A)).accounts["acc-1"]).toEqual({
      label: "label acc-1",
      status: "pending",
    });
  });

  it("finished / expired / mismatched round id: no-op, nothing written", async () => {
    await open(USER_A, "r1");
    expect(Option.isNone(await enlist(NOW + 1, "acc-3", "STALE"))).toBe(true);
    expect(Option.isNone(await enlist(NOW + TTL, "acc-3"))).toBe(true);
    await rounds(USER_A, NOW + 2).finish({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });
    expect(Option.isNone(await enlist(NOW + 3, "acc-3"))).toBe(true);
    expect((await read(USER_A)).accounts["acc-3"]).toBeUndefined();
  });
});
