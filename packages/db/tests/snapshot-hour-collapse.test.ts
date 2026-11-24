import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// Snapshots from sync collapse per clock hour: for one account, only the last in an hour is kept.
//
// Needs real D1: the delete-then-insert batch atomicity and ON DELETE CASCADE removing balance rows can't be proven on a fake db.
const snapshotsOf = forDomain((db) => db.snapshots);
const accountsOf = forDomain((db) => db.accounts);

const USER = "user-collapse";
const OTHER = "user-collapse-other";
const HOUR = 3_600_000;
// A top-of-hour instant (1_800_000_000_000 isn't one, so take the start of its hour) to make same/different hour explicit.
const H0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR;

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

/** Writes one snapshot; `holdings` sets the balance row count (to see whether the cascade removed them). */
const write = (
  accountId: string,
  takenAt: number,
  totalUsd: number,
  { collapse = true, holdings = 1, userId = USER } = {},
) =>
  snapshotsOf(userId).write(
    accountId,
    {
      takenAt,
      totalUsd,
      balances: Array.from({ length: holdings }, (_, i) => ({
        amount: 1,
        usdValue: totalUsd / holdings,
        kind: "spot" as const,
        tokenId: `tok-${i}`, // any non-empty value (NOT NULL, no FK); identity is irrelevant here
      })),
    },
    { collapseSameHour: collapse },
  );

const count = async (sql: string): Promise<number> =>
  (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

const snapshotRows = () => count("SELECT COUNT(*) AS n FROM snapshots");
const balanceRows = () => count("SELECT COUNT(*) AS n FROM snapshot_balances");

describe("hour collapse", () => {
  it("writing again within the same hour leaves only the later one", async () => {
    const acc = await account("a");
    await write(acc, H0 + 5 * 60_000, 100);
    await write(acc, H0 + 35 * 60_000, 200);

    expect(await snapshotRows()).toBe(1);
    const [row] = await snapshotsOf(USER).listByAccount(acc);
    expect(row.totalUsd).toBe(200);
    expect(row.takenAt).toBe(H0 + 35 * 60_000);
  });

  it("the collapsed snapshot's balance rows go with it (via ON DELETE CASCADE, not a manual delete)", async () => {
    // Collapse deletes only `snapshots`; balance rows that stayed would be unreadable orphans piling up hourly.
    const acc = await account("cascade");
    await write(acc, H0 + 1000, 100, { holdings: 3 });
    expect(await balanceRows()).toBe(3);

    await write(acc, H0 + 2000, 100, { holdings: 2 });
    expect(await snapshotRows()).toBe(1);
    expect(await balanceRows()).toBe(2); // the old 3 are gone, only the new 2 remain
  });

  it("different hours don't collapse: one millisecond apart is two hours", async () => {
    // Cut by absolute hour (as the read side does), not "within an hour of the previous": 59:59.999 and the next 00:00.000 are 1ms apart but separate buckets.
    const acc = await account("edge");
    await write(acc, H0 + HOUR - 1, 100);
    await write(acc, H0 + HOUR, 200);

    expect(await snapshotRows()).toBe(2);
  });

  it("does not collapse by default: without the flag it appends as before", async () => {
    // Import (`importSnapshot`) calls this method and restores historical facts, so the default must not collapse.
    const acc = await account("append");
    await write(acc, H0 + 1000, 100, { collapse: false });
    await write(acc, H0 + 2000, 200, { collapse: false });

    expect(await snapshotRows()).toBe(2);
  });

  it("collapses only the same account: another account's same-hour snapshot is untouched", async () => {
    const a = await account("a");
    const b = await account("b");
    await write(a, H0 + 1000, 100);
    await write(b, H0 + 1000, 50);
    await write(a, H0 + 2000, 300);

    expect(await snapshotRows()).toBe(2); // one of a, one of b
    const [rowB] = await snapshotsOf(USER).listByAccount(b);
    expect(rowB.totalUsd).toBe(50);
  });

  it("does not cross users: another user's same-hour snapshots are untouched", async () => {
    const theirs = await account("theirs", OTHER);
    await write(theirs, H0 + 1000, 70, { userId: OTHER });

    const mine = await account("mine");
    await write(mine, H0 + 1000, 100);
    await write(mine, H0 + 2000, 200);

    expect(await snapshotRows()).toBe(2); // mine and theirs
    const [rowTheirs] = await snapshotsOf(OTHER).listByAccount(theirs);
    expect(rowTheirs.totalUsd).toBe(70);
  });

  it("returns the new snapshot's id; the old id is gone", async () => {
    const acc = await account("ids");
    const first = await write(acc, H0 + 1000, 100);
    const second = await write(acc, H0 + 2000, 200);

    expect(second).not.toBe(first);
    const [row] = await snapshotsOf(USER).listByAccount(acc);
    expect(row.id).toBe(second);
  });

  it("the overview reads the collapsed snapshot", async () => {
    const acc = await account("latest");
    await write(acc, H0 + 1000, 100, { holdings: 2 });
    await write(acc, H0 + 2000, 250, { holdings: 1 });

    const [latest] = await snapshotsOf(USER).latest();
    expect(latest.snapshot.totalUsd).toBe(250);
    expect(latest.balances).toHaveLength(1);
  });
});
