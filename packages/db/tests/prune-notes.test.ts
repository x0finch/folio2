import { env } from "cloudflare:test";
import type { Note } from "@folio/connectors-basic";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// Retention of display notes: cron prunes notes outside the window daily, only notes (never meta), and never each account's latest snapshot.
//
// Needs real D1: after pruning the read path returns null, indistinguishable from "never had a note"; only counting rows tells a real prune from a no-op.
//
// Orchestration (per user, window computation) is in `apps/web/tests/server/prune-notes-all-users.test.ts`.
const snapshotsOf = forDomain((db) => db.snapshots);
const accountsOf = forDomain((db) => db.accounts);

const USER = "user-prune";
const OTHER = "user-prune-other";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const WINDOW = 7 * DAY;

const note = (title: string): Note[] => [{ title, content: [{ label: "n", value: 1 }] }];
const balanceNote = (title: string): Note => ({ title, content: [{ label: "n", value: 1 }] });

// pool-workers doesn't isolate storage per test: delete the user row (cascades accounts/snapshots/...) and re-insert.
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
  await resetUser(USER);
  await resetUser(OTHER);
});

const account = (label: string, userId = USER) =>
  accountsOf(userId)
    .create({ connectorId: "bitcoin", label, creds: null })
    .then((a) => a.id);

/** Writes a snapshot with a note (optionally one balance, which has its own note + meta). */
const snap = (accountId: string, takenAt: number, withBalance = false, userId = USER) =>
  snapshotsOf(userId).write(accountId, {
    takenAt,
    totalUsd: 1,
    note: note(`n@${takenAt}`),
    balances: withBalance
      ? [
          {
            amount: 1,
            usdValue: 1,
            kind: "defi",
            tokenId: "tok-x", // any non-empty value (NOT NULL, no FK); identity is irrelevant here
            note: balanceNote(`b@${takenAt}`),
            meta: { protocol: "aave" },
          },
        ]
      : [],
  });

const count = async (sql: string): Promise<number> =>
  (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

const notedSnapshots = () => count("SELECT COUNT(*) AS n FROM snapshots WHERE note IS NOT NULL");
const notedBalances = () =>
  count("SELECT COUNT(*) AS n FROM snapshot_balances WHERE note IS NOT NULL");
const metaRows = () =>
  count("SELECT COUNT(*) AS n FROM snapshot_balances WHERE meta_json IS NOT NULL");

const prune = (olderThan = NOW - WINDOW, userId = USER) =>
  snapshotsOf(userId).pruneNotes(olderThan);

describe("prune notes by retention", () => {
  it("prunes outside the window and keeps inside", async () => {
    const acc = await account("a");
    await snap(acc, NOW - 30 * DAY); // outside the window
    await snap(acc, NOW - 10 * DAY); // outside the window
    await snap(acc, NOW - 1 * DAY); // inside the window
    await snap(acc, NOW); // inside the window + latest

    const r = await prune();
    expect(r.snapshots).toBe(2);
    expect(await notedSnapshots()).toBe(2);
  });

  it("**each account's latest is never pruned**, even entirely outside the window", async () => {
    // A stopped account (archived / bad credentials) sits wholly outside the window; a time cutoff would prune its only note, yet the UI reads exactly that snapshot.
    const acc = await account("stale");
    await snap(acc, NOW - 100 * DAY);
    await snap(acc, NOW - 90 * DAY); // this is the latest, though also old

    const r = await prune();
    expect(r.snapshots).toBe(1); // only the earlier one was pruned
    expect(await notedSnapshots()).toBe(1);
    // What remains must be the latest
    const kept = await env.DB.prepare(
      "SELECT taken_at AS t FROM snapshots WHERE note IS NOT NULL",
    ).first<{ t: number }>();
    expect(kept?.t).toBe(NOW - 90 * DAY);
  });

  it("each account judges its own latest, not one global pick", async () => {
    const a = await account("a");
    const b = await account("b");
    await snap(a, NOW - 50 * DAY);
    await snap(a, NOW - 40 * DAY); // a's latest
    await snap(b, NOW - 30 * DAY);
    await snap(b, NOW - 20 * DAY); // b's latest

    await prune();
    expect(await notedSnapshots()).toBe(2); // one kept per account
  });

  it("an account with one snapshot loses none", async () => {
    const acc = await account("solo");
    await snap(acc, NOW - 99 * DAY);

    const r = await prune();
    expect(r.snapshots).toBe(0);
    expect(await notedSnapshots()).toBe(1);
  });

  it("balance-level notes are pruned too", async () => {
    const acc = await account("bal");
    await snap(acc, NOW - 30 * DAY, true);
    await snap(acc, NOW, true);

    const r = await prune();
    expect(r.balances).toBe(1);
    expect(await notedBalances()).toBe(1);
  });

  it("**`meta_json` is never touched**: shared logic reads it and pruning would corrupt history", async () => {
    // 24h P&L reads DeFi protocol names from meta and balance-kind reads role from old perp rows; notes may be pruned because no shared logic reads them, meta may not.
    const acc = await account("meta");
    await snap(acc, NOW - 30 * DAY, true);
    await snap(acc, NOW, true);
    expect(await metaRows()).toBe(2);

    await prune();
    expect(await metaRows()).toBe(2); // pruning notes leaves meta alone
  });

  it("idempotent: pruning again changes nothing", async () => {
    const acc = await account("idem");
    await snap(acc, NOW - 30 * DAY, true);
    await snap(acc, NOW, true);

    const first = await prune();
    const second = await prune();
    expect(first.snapshots).toBe(1);
    expect(second.snapshots).toBe(0);
    expect(second.balances).toBe(0);
  });

  it("doesn't cross users: another user's notes are untouched", async () => {
    // Another user: both snapshots are old enough that one would be pruned on time alone, but this run prunes USER.
    const theirs = await account("theirs", OTHER);
    await snap(theirs, NOW - 60 * DAY, false, OTHER);
    await snap(theirs, NOW - 50 * DAY, false, OTHER);

    const mine = await account("mine");
    await snap(mine, NOW - 30 * DAY);
    await snap(mine, NOW);

    const r = await prune();
    expect(r.snapshots).toBe(1); // only mine was pruned
    // The whole db still has 3 noted snapshots: my latest 1 plus the other's 2
    expect(await notedSnapshots()).toBe(3);
  });
});

describe("read path after pruning", () => {
  it("the UI path (latest) is unaffected: it reads the latest snapshot", async () => {
    const acc = await account("read");
    await snap(acc, NOW - 30 * DAY);
    await snap(acc, NOW);

    await prune();
    const [row] = await snapshotsOf(USER).latest();
    expect(row.note?.[0]?.title).toBe(`n@${NOW}`);
  });

  it("the export path (listPage) gets old snapshots with empty notes, but the rows remain", async () => {
    const acc = await account("export");
    await snap(acc, NOW - 30 * DAY);
    await snap(acc, NOW);

    await prune();
    const page = await snapshotsOf(USER).listPage(10, 0);
    expect(page).toHaveLength(2); // neither snapshot was deleted
    expect(page.filter((s) => s.note != null)).toHaveLength(1);
  });
});
