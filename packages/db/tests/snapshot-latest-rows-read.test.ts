import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { provideDbClient } from "../src/client";
import { getDb } from "../src/connect";
import { provideCurrentUser } from "../src/current-user";
import { Database } from "../src/database";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// D1 billing regression (`rows_read`) for `latest()` / `asOf()`. D1 bills by rows_read and these reads run on every page load and cron round; the old GROUP BY + max() read ~2x total snapshots. The property is that rows read depend on account count, not snapshot count, so the assertion compares two scales rather than an absolute value.
//
// drizzle's D1 driver drops `meta`, so a recording D1 binding forwards calls, records each statement's SQL + params, and the recorded statement is re-run through the raw binding to read `meta`: it measures the production statement, not an equivalent copy.

const USER = "user-rows-read";
const ACCOUNTS = 10;
const HOUR_MS = 3_600_000;

const accountsOf = forDomain((db) => db.accounts);

interface Recorded {
  sql: string;
  params: unknown[];
}

// Pass-through D1 binding: `prepare` records SQL, `bind` records params, the rest forwards. `.bind(target)` returns the original object because workerd bindings are native and a Proxy `this` breaks.
function recordingD1(db: D1Database, log: Recorded[]): D1Database {
  const passthrough = <T extends object>(target: T, key: string | symbol): unknown => {
    const v = Reflect.get(target, key);
    return typeof v === "function" ? v.bind(target) : v;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") return passthrough(target, key);
      return (sql: string) => {
        const entry: Recorded = { sql, params: [] };
        log.push(entry);
        const stmt = target.prepare(sql);
        return new Proxy(stmt, {
          get(s, k) {
            if (k !== "bind") return passthrough(s, k);
            return (...params: unknown[]) => {
              entry.params = params;
              return s.bind(...params);
            };
          },
        });
      };
    },
  });
}

// Runs `pick(snapshots)` once as USER and returns the first statement it emits (the snapshot one; the second fetches balances by id).
async function firstStatementOf(
  pick: (
    s: Database["Service"]["snapshots"],
  ) => ReturnType<Database["Service"]["snapshots"]["latest"]>,
): Promise<Recorded> {
  const log: Recorded[] = [];
  await Effect.runPromise(
    Effect.flatMap(Database, (db) => pick(db.snapshots)).pipe(
      Effect.provide(Database.layer),
      provideCurrentUser(USER),
      provideDbClient({ DB: recordingD1(env.DB, log) }),
    ),
  );
  const first = log[0];
  if (!first) throw new Error("no statement recorded");
  return first;
}

async function rowsRead(stmt: Recorded): Promise<number> {
  const { meta } = await env.DB.prepare(stmt.sql)
    .bind(...stmt.params)
    .all();
  return meta.rows_read;
}

async function queryPlan(stmt: Recorded): Promise<string[]> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`)
    .bind(...stmt.params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

// Tops each account up to `perAccount` hourly snapshots ([from, perAccount)) with one INSERT ... SELECT over a recursive CTE, so 6000 rows take one round trip.
async function seedHourly(from: number, perAccount: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO snapshots (id, account_id, taken_at, total_usd)
     WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
     SELECT a.id || '-' || n.i, a.id, n.i * ?, n.i FROM accounts a, n WHERE a.user_id = ?`,
  )
    .bind(from, perAccount, HOUR_MS, USER)
    .run();
}

async function snapshotCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM snapshots s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?",
  )
    .bind(USER)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, USER)); // cascades accounts / snapshots
  await db.insert(user).values({
    id: USER,
    name: USER,
    email: `${USER}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  for (let i = 0; i < ACCOUNTS; i++) {
    await accountsOf(USER).create({ connectorId: "manual", label: `A${i}`, creds: "x" });
  }
});

describe("snapshots rows_read does not grow with total snapshots", () => {
  // One point lookup per account is ~3 rows (account row + index probe + snapshot row), measured exactly accounts x 3; the bound leaves a constant margin. Old code: latest() read 4038 at 2000 snapshots and 12038 at 6000.
  const CEILING = ACCOUNTS * 3 + 5;

  it("latest(): 2000 and 6000 snapshots read the same row count, <= accounts x 3 + constant", async () => {
    await seedHourly(0, 200);
    expect(await snapshotCount()).toBe(2000);
    const small = await firstStatementOf((s) => s.latest());
    const smallRead = await rowsRead(small);

    await seedHourly(200, 600);
    expect(await snapshotCount()).toBe(6000);
    const large = await firstStatementOf((s) => s.latest());
    const largeRead = await rowsRead(large);

    expect(largeRead).toBe(smallRead);
    expect(largeRead).toBeLessThanOrEqual(CEILING);

    // Plan: the snapshot side is an index SEARCH on (account_id, taken_at), not a full SCAN.
    const plan = await queryPlan(large);
    expect(plan.some((d) => /SEARCH .*snapshots_account_id_taken_at_idx/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN (snapshots|x)\b/.test(d))).toBe(false);

    // Behaviour unchanged: one per account, the latest one (index 599).
    const rows = await Effect.runPromise(
      Effect.flatMap(Database, (db) => db.snapshots.latest()).pipe(
        Effect.provide(Database.layer),
        provideCurrentUser(USER),
        provideDbClient(env),
      ),
    );
    expect(rows).toHaveLength(ACCOUNTS);
    expect(rows.every((r) => r.snapshot.takenAt === 599 * HOUR_MS)).toBe(true);
  });

  // Production shape: t = latest - 24h, floor = t - 7d. The old code's reads grew with snapshots in the window (3420 rows when full); now it's one point lookup per account.
  it("asOf(): production-shaped [t-7d, t] window, reads independent of total and <= accounts x 3 + constant", async () => {
    const measureAt = async (top: number) => {
      const t = (top - 24) * HOUR_MS;
      const stmt = await firstStatementOf((s) => s.asOf(t, t - 7 * 24 * HOUR_MS));
      return { stmt, read: await rowsRead(stmt) };
    };

    await seedHourly(0, 200);
    const small = await measureAt(199);
    await seedHourly(200, 600);
    const large = await measureAt(599);

    expect(large.read).toBe(small.read);
    expect(large.read).toBeLessThanOrEqual(CEILING);
    expect(
      (await queryPlan(large.stmt)).some((d) =>
        /SEARCH .*snapshots_account_id_taken_at_idx/.test(d),
      ),
    ).toBe(true);
  });
});
