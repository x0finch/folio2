import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { provideDbClient } from "../src/client";
import { getDb } from "../src/connect";
import { provideCurrentUser } from "../src/current-user";
import { Database, type DbRequest } from "../src/database";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// 日汇总(FOL-91):写侧跟着快照同一个 batch 维护、迁移回填、长窗读它而不扫快照。
//
// **为什么非真 D1 不可**:维护语句靠的是「batch 按序执行、后一条读得到前一条写的行」+ SQLite
// upsert 的 `excluded` 语义,回填靠窗口函数 —— 这些只有真库答得了。

const snapshotsOf = forDomain((db) => db.snapshots);
const accountsOf = forDomain((db) => db.accounts);

const USER = "user-daily-totals";
const HOUR = 3_600_000;
const DAY = 86_400_000;
// 某个 UTC 零点(取 1_800_000_000_000 所在那天的起点)。
const D0 = Math.floor(1_800_000_000_000 / DAY) * DAY;

interface DailyRow {
  account_id: string;
  day: number;
  open_usd: number;
  open_at: number;
  min_usd: number;
  min_at: number;
  max_usd: number;
  max_at: number;
  close_usd: number;
  close_at: number;
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
  await resetUser(USER);
});

const account = (label: string) =>
  accountsOf(USER)
    .create({ connectorId: "bitcoin", label, creds: null })
    .then((a) => a.id);

const write = (accountId: string, takenAt: number, totalUsd: number, collapse = false) =>
  snapshotsOf(USER).write(
    accountId,
    {
      takenAt,
      totalUsd,
      balances: [{ amount: 1, usdValue: totalUsd, kind: "spot", tokenId: "t" }],
    },
    { collapseSameHour: collapse },
  );

/** 本用户的全部日汇总行,按 (account, day) 排好。 */
async function dailyRows(): Promise<DailyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.* FROM account_daily_totals d JOIN accounts a ON a.id = d.account_id
     WHERE a.user_id = ? ORDER BY d.account_id, d.day`,
  )
    .bind(USER)
    .all<DailyRow>();
  return results;
}

/** 参照系:直接从快照按定义现算(与写侧 / 回填各自独立的第三份实现)。 */
async function expectedFromSnapshots(): Promise<DailyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.account_id, s.taken_at, s.total_usd, s.rowid AS rid FROM snapshots s
     JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?`,
  )
    .bind(USER)
    .all<{ account_id: string; taken_at: number; total_usd: number; rid: number }>();
  const groups = new Map<string, typeof results>();
  for (const r of results) {
    const key = `${r.account_id}|${Math.floor(r.taken_at / DAY) * DAY}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: DailyRow[] = [];
  for (const [key, rows] of groups) {
    const [accountId, day] = key.split("|");
    const byTime = [...rows].sort((a, b) => a.taken_at - b.taken_at || a.rid - b.rid);
    const low = [...rows].sort(
      (a, b) => a.total_usd - b.total_usd || a.taken_at - b.taken_at || a.rid - b.rid,
    )[0];
    const high = [...rows].sort(
      (a, b) => b.total_usd - a.total_usd || a.taken_at - b.taken_at || a.rid - b.rid,
    )[0];
    const first = byTime[0];
    const last = byTime[byTime.length - 1];
    out.push({
      account_id: accountId,
      day: Number(day),
      open_usd: first.total_usd,
      open_at: first.taken_at,
      min_usd: low.total_usd,
      min_at: low.taken_at,
      max_usd: high.total_usd,
      max_at: high.taken_at,
      close_usd: last.total_usd,
      close_at: last.taken_at,
    });
  }
  return out.sort((a, b) => a.account_id.localeCompare(b.account_id) || a.day - b.day);
}

describe("写快照时维护日汇总", () => {
  it("追加写(乱序到达)→ open/min/max/close 各就各位", async () => {
    const acc = await account("a");
    await write(acc, D0 + 10 * HOUR, 150);
    await write(acc, D0 + 2 * HOUR, 120); // 更早 → 成为 open
    await write(acc, D0 + 20 * HOUR, 130); // 最晚 → close
    await write(acc, D0 + 5 * HOUR, 90); // 最低
    await write(acc, D0 + 15 * HOUR, 200); // 最高
    await write(acc, D0 + DAY + HOUR, 1); // 第二天,自成一行

    expect(await dailyRows()).toEqual([
      {
        account_id: acc,
        day: D0,
        open_usd: 120,
        open_at: D0 + 2 * HOUR,
        min_usd: 90,
        min_at: D0 + 5 * HOUR,
        max_usd: 200,
        max_at: D0 + 15 * HOUR,
        close_usd: 130,
        close_at: D0 + 20 * HOUR,
      },
      {
        account_id: acc,
        day: D0 + DAY,
        open_usd: 1,
        open_at: D0 + DAY + HOUR,
        min_usd: 1,
        min_at: D0 + DAY + HOUR,
        max_usd: 1,
        max_at: D0 + DAY + HOUR,
        close_usd: 1,
        close_at: D0 + DAY + HOUR,
      },
    ]);
  });

  it("collapseSameHour 换掉的正是当天最高点 → 整日重算,旧极值退出", async () => {
    const acc = await account("collapse");
    await write(acc, D0 + 3 * HOUR, 100, true);
    await write(acc, D0 + 9 * HOUR + 60_000, 500, true); // 当天最高
    await write(acc, D0 + 12 * HOUR, 110, true);
    // 同一钟点再同步一次:500 那张被删,换成 105。增量比较会让 500 留在 max 上 —— 必须重算。
    await write(acc, D0 + 9 * HOUR + 30 * 60_000, 105, true);

    const [row] = await dailyRows();
    expect(row.max_usd).toBe(110);
    expect(row.max_at).toBe(D0 + 12 * HOUR);
    expect(row.min_usd).toBe(100);
    expect(row.close_usd).toBe(110);
    expect(await dailyRows()).toEqual(await expectedFromSnapshots());
  });

  it("collapseSameHour 换掉的是当天唯一 / 最后那张 → close 跟着换", async () => {
    const acc = await account("only");
    await write(acc, D0 + 23 * HOUR + 1000, 300, true);
    await write(acc, D0 + 23 * HOUR + 2000, 250, true);

    expect(await dailyRows()).toEqual([
      {
        account_id: acc,
        day: D0,
        open_usd: 250,
        open_at: D0 + 23 * HOUR + 2000,
        min_usd: 250,
        min_at: D0 + 23 * HOUR + 2000,
        max_usd: 250,
        max_at: D0 + 23 * HOUR + 2000,
        close_usd: 250,
        close_at: D0 + 23 * HOUR + 2000,
      },
    ]);
  });

  it("删账户 → 它的日汇总一起走(外键级联)", async () => {
    const acc = await account("gone");
    await write(acc, D0 + HOUR, 10);
    expect(await dailyRows()).toHaveLength(1);
    await accountsOf(USER).remove(acc);
    expect(await dailyRows()).toHaveLength(0);
  });
});

describe("迁移回填", () => {
  it("回填语句从快照重算出的行,与写侧一路维护出来的逐字相同", async () => {
    const a = await account("a");
    const b = await account("b");
    // 混着来:追加 + 折叠、乱序、同值并列、跨天、同刻并列。
    for (let h = 0; h < 50; h++) {
      await write(a, D0 + h * HOUR + 60_000, 100 + ((h * 37) % 23), h % 2 === 0);
    }
    await write(a, D0 + 4 * HOUR + 60_000, 100 + ((4 * 37) % 23), true); // 同钟点再写同值
    await write(b, D0 + 30 * HOUR, 50);
    await write(b, D0 + 30 * HOUR, 60); // 同刻并列:后写的是 close
    await write(b, D0 + 26 * HOUR, 60); // 与最高同值、更早 → max_at 取它
    await write(b, D0 + 2 * HOUR, 70);

    const maintained = await dailyRows();
    expect(maintained).toEqual(await expectedFromSnapshots());

    // 取迁移文件里真的那条回填语句(不另抄一份 —— 抄的那份会和迁移慢慢走样)。
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.includes("account_daily_totals"));
    const backfill = migration?.queries.find((q) => q.includes("INSERT OR REPLACE"));
    expect(backfill).toBeDefined();

    await env.DB.prepare(
      "DELETE FROM account_daily_totals WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)",
    )
      .bind(USER)
      .run();
    expect(await dailyRows()).toHaveLength(0);
    await env.DB.prepare(backfill as string).run();

    expect(await dailyRows()).toEqual(maintained);
  }, 30_000);
});

// —— 读侧 ——

interface Recorded {
  sql: string;
  params: unknown[];
}

// 透传的 D1 绑定,记下每条语句(同 snapshot-latest-rows-read.test.ts)。
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

async function recorded<A>(
  pick: (s: Database["snapshots"]) => Effect.Effect<A, unknown, DbRequest>,
): Promise<{ result: A; statements: Recorded[] }> {
  const statements: Recorded[] = [];
  const result = await Effect.runPromise(
    Effect.flatMap(Database, (db) => pick(db.snapshots)).pipe(
      Effect.provide(Database.Default),
      provideCurrentUser(USER),
      provideDbClient({ DB: recordingD1(env.DB, statements) }),
      Effect.orDie,
    ),
  );
  return { result, statements };
}

async function rowsRead(stmts: Recorded[]): Promise<number> {
  let n = 0;
  for (const s of stmts) {
    const { meta } = await env.DB.prepare(s.sql)
      .bind(...s.params)
      .all();
    n += meta.rows_read;
  }
  return n;
}

async function plan(stmts: Recorded[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of stmts) {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`)
      .bind(...s.params)
      .all<{ detail: string }>();
    out.push(...results.map((r) => r.detail));
  }
  return out;
}

// 逐小时快照直接灌 SQL(几千行,走 write 太慢),再用回填语句把日汇总补上 —— 与生产迁移同一条路。
async function seedHourly(accountIds: string[], fromHour: number, toHour: number): Promise<void> {
  for (const id of accountIds) {
    await env.DB.prepare(
      `INSERT INTO snapshots (id, account_id, taken_at, total_usd)
       WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
       SELECT ? || '-' || n.i, ?, ? + n.i * ?, 1000 + (n.i * 7919) % 500 FROM n`,
    )
      .bind(fromHour, toHour, id, id, D0, HOUR)
      .run();
  }
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.includes("account_daily_totals"));
  const backfill = migration?.queries.find((q) => q.includes("INSERT OR REPLACE"));
  await env.DB.prepare(backfill as string).run();
}

describe("长窗读日汇总,不扫快照", () => {
  const ACCOUNTS = 3;
  const WINDOW_DAYS = 30;

  it("30 天窗口:历史 60 天 → 400 天,读的行数不变;语句里没有整表扫快照", async () => {
    const ids: string[] = [];
    for (let i = 0; i < ACCOUNTS; i++) ids.push(await account(`A${i}`));

    const measure = async (historyDays: number) => {
      const now = D0 + historyDays * DAY;
      const since = now - WINDOW_DAYS * DAY;
      const portfolio = await recorded((s) => s.listDailyTotals(ids, since));
      const sampled = await recorded((s) => s.listSampledTotals(ids, since));
      const single = await recorded((s) => s.listDailyTotalsByAccount(ids[0], since));
      const singleSampled = await recorded((s) => s.listSampledTotalsByAccount(ids[0], since));
      const all = { portfolio, sampled, single, singleSampled };
      // 读数当场量:窗口只有下界,种了更多历史之后再量「小」那组就不是同一个窗口了。
      const reads = {} as Record<keyof typeof all, number>;
      for (const k of Object.keys(all) as (keyof typeof all)[]) {
        reads[k] = await rowsRead(all[k].statements);
      }
      return { ...all, reads };
    };

    await seedHourly(ids, 0, 60 * 24);
    const small = await measure(60);
    await seedHourly(ids, 60 * 24, 400 * 24);
    const large = await measure(400);

    for (const k of ["portfolio", "sampled", "single", "singleSampled"] as const) {
      expect(large.reads[k]).toBe(small.reads[k]);
      const details = await plan(large[k].statements);
      // 快照表只许被按 (account_id, taken_at) 索引点查(carry-in),不许 SCAN。
      expect(details.some((d) => /^SCAN (snapshots|s)\b/.test(d))).toBe(false);
    }
    // 组合日线:每账户每天 ≤ 1 行 + carry-in 一行。
    expect(large.portfolio.result.length).toBeLessThanOrEqual(ACCOUNTS * (WINDOW_DAYS + 2));
    // 单账户日线:每天 ≤ 4 点。
    expect(large.single.result.length).toBeLessThanOrEqual(4 * (WINDOW_DAYS + 1));
    // 读 400 天历史的 30 天窗口,读数远小于窗口内的逐小时快照数。
    expect(large.reads.portfolio).toBeLessThan(ACCOUNTS * WINDOW_DAYS * 24);
  }, 120_000);
});

// —— 对拍:日汇总画出来的图,与逐小时快照画出来的在「日」这一粒度上一个点都不差 ——

/** 组合阶梯重建(与 apps/web buildPortfolioHistory 同语义)。 */
function timeline(rows: readonly { accountId: string; takenAt: number; totalUsd: number }[]) {
  const sorted = [...rows].sort((a, b) => a.takenAt - b.takenAt);
  const latest = new Map<string, number>();
  const out: { t: number; total: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    latest.set(sorted[i].accountId, sorted[i].totalUsd);
    if (i + 1 < sorted.length && sorted[i + 1].takenAt === sorted[i].takenAt) continue;
    let total = 0;
    for (const v of latest.values()) total += v;
    out.push({ t: sorted[i].takenAt, total });
  }
  return out;
}

/** 每个 UTC 日留最后一个点(与 apps/web `toDailySeries` 在 30 天跨度上的行为相同)。 */
const lastPerDay = (points: readonly { t: number; total: number }[]) => {
  const m = new Map<number, { t: number; total: number }>();
  for (const p of points) m.set(Math.floor(p.t / DAY), p);
  return [...m.values()];
};

describe("对拍(golden):日汇总 vs 逐小时快照", () => {
  it("组合 30 天:每日收盘点与逐小时重建逐点相同;单账户 1 年:极值与端点相同", async () => {
    const a = await account("a");
    const b = await account("b");
    const cold = await account("cold");
    // a / b 逐小时 40 天,值各自起伏;cold 只在窗口前有一张(carry-in 那条路)。b 晚 3 天入场。
    for (let h = 0; h < 40 * 24; h += 1) {
      await write(a, D0 + h * HOUR + 60_000, 1000 + Math.round(Math.sin(h / 7) * 300), true);
      if (h >= 72) {
        await write(b, D0 + h * HOUR + 60_000, 500 + Math.round(Math.cos(h / 5) * 120), true);
      }
    }
    await write(cold, D0 - 5 * DAY, 777, true);

    const now = D0 + 40 * DAY;
    const since = now - 30 * DAY + 5 * HOUR; // 窗口起点落在某天中间
    const ids = [a, b, cold];

    const hourly = await snapshotsOf(USER).listTotals(since); // 旧那条路的原料
    const daily = await snapshotsOf(USER).listDailyTotals(ids, since);

    expect(daily.length).toBeLessThanOrEqual(ids.length * 32);
    expect(hourly.length).toBeGreaterThan(daily.length * 10);
    expect(lastPerDay(timeline(daily))).toEqual(lastPerDay(timeline(hourly)));

    // 单账户:30 天的日点在「每天最后一个点」上与原始点相同(浏览器 downsampleSeries 取的就是它)。
    const rawA = await snapshotsOf(USER).listTotalsByAccount(a, since);
    const dailyA = await snapshotsOf(USER).listDailyTotalsByAccount(a, since);
    const asPoints = (rows: { takenAt: number; totalUsd: number }[]) =>
      rows.map((r) => ({ t: r.takenAt, total: r.totalUsd }));
    expect(lastPerDay(asPoints(dailyA))).toEqual(lastPerDay(asPoints(rawA)));
    // 日点都是真实观测(每个都能在原始点里找到)。
    const rawSet = new Set(rawA.map((r) => `${r.takenAt}:${r.totalUsd}`));
    expect(dailyA.every((r) => rawSet.has(`${r.takenAt}:${r.totalUsd}`))).toBe(true);

    // 单账户长窗(SQL 按桶封顶,FOL-92):全局最高 / 最低与原始点相同,首末点相同。
    const sampledA = await snapshotsOf(USER).listSampledTotalsByAccount(a);
    const allA = await snapshotsOf(USER).listTotalsByAccount(a);
    const vals = (rows: { totalUsd: number }[]) => rows.map((r) => r.totalUsd);
    expect(Math.max(...vals(sampledA))).toBe(Math.max(...vals(allA)));
    expect(Math.min(...vals(sampledA))).toBe(Math.min(...vals(allA)));
    expect(sampledA[0]).toEqual(allA[0]);
    expect(sampledA[sampledA.length - 1]).toEqual(allA[allA.length - 1]);
    expect(sampledA.length).toBeLessThanOrEqual(400);
  }, 300_000);
});
