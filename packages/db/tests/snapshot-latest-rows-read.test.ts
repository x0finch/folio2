import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { dbClientLayer } from "../src/client";
import { getDb } from "../src/connect";
import { CurrentUser } from "../src/current-user";
import { Database } from "../src/database";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// `latest()` / `asOf()` 的 D1 计费回归(`rows_read`)。
//
// **为什么要钉这个数**:D1 按 `rows_read` 计费(免费档每天 500 万行,超了直接报错),而这两个读
// 每次页面加载 + 每轮 cron 两趟都要跑。旧写法是 `GROUP BY account_id` + `max(taken_at)`,SQLite
// 得把每个账户的索引项全走一遍 → `rows_read ≈ 2 × 快照总数`,随历史线性长。要的性质是
// **读多少行只跟账户数有关,跟攒了多少快照无关** —— 所以断言的是「两个规模下读数相同」,
// 不是某个绝对值。
//
// **怎么拿到 `rows_read`**:drizzle 的 D1 驱动把 `meta` 丢了。这里不另写一份「等价 SQL」来量
// (那份会和生产那条慢慢走样),而是给 `DbClient` 喂一个**记录型** D1 绑定:它原样转发,顺手记下
// 每条语句的 SQL + 参数;再把记下的那条原样经裸绑定 `.all()` 重跑一遍读 `meta`。量的就是生产那条。

const USER = "user-rows-read";
const ACCOUNTS = 10;
const HOUR_MS = 3_600_000;

const accountsOf = forDomain((db) => db.accounts);

interface Recorded {
  sql: string;
  params: unknown[];
}

// 透传的 D1 绑定:`prepare(sql)` 记 SQL,`bind(...)` 记参数,其余一律转给真绑定。
// 方法 `.bind(target)` 回原对象 —— workerd 的绑定是原生对象,`this` 换成 Proxy 会炸。
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

// 以 USER 跑一次 `pick(snapshots)`,返回它发出的**第一条**语句(快照那条;第二条是按 id 取余额)。
async function firstStatementOf(
  pick: (s: Database["snapshots"]) => Effect.Effect<unknown>,
): Promise<Recorded> {
  const log: Recorded[] = [];
  const layer = Database.Default.pipe(
    Layer.provide(Layer.succeed(CurrentUser, USER)),
    Layer.provide(dbClientLayer({ DB: recordingD1(env.DB, log) })),
  );
  await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(Database, (db) => pick(db.snapshots)),
      layer,
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

// 每账户补到 `perAccount` 张逐小时快照(`[from, perAccount)` 这一段)。一条 INSERT … SELECT,
// 递归 CTE 出序号 × 本用户账户 —— 6000 行一趟往返,不必在 JS 里拼几百条语句。
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
  await db.delete(user).where(eq(user.id, USER)); // 级联清掉账户 / 快照
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

describe("snapshots rows_read 不随快照总数增长", () => {
  // 每账户一次点查 ≈ 账户行 + 索引探一下 + 取快照行 = 3 行(实测正好 `账户数 × 3`),上界留一点
  // 常数余量。旧写法实测:latest() 2000 张读 4038、6000 张读 12038;asOf() 生产窗口读 3420。
  const CEILING = ACCOUNTS * 3 + 5;

  it("latest():2000 与 6000 张快照读的行数相同,且 ≤ 账户数 × 3 + 常数", async () => {
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

    // 计划:快照那侧是按 (account_id, taken_at) 索引的 SEARCH,不是整表 SCAN。
    const plan = await queryPlan(large);
    expect(plan.some((d) => /SEARCH .*snapshots_account_id_taken_at_idx/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN (snapshots|x)\b/.test(d))).toBe(false);

    // 行为没变:每账户一张,且是最新那张(序号 599)。
    const rows = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Database, (db) => db.snapshots.latest()),
        Database.Default.pipe(
          Layer.provide(Layer.succeed(CurrentUser, USER)),
          Layer.provide(dbClientLayer(env)),
        ),
      ),
    );
    expect(rows).toHaveLength(ACCOUNTS);
    expect(rows.every((r) => r.snapshot.takenAt === 599 * HOUR_MS)).toBe(true);
  });

  // 生产那条的形状(ADR 0050):t = 最新 −24h,floor = t −7d。旧写法的读数跟窗口里有多少张走
  // (窗口塞满逐小时快照时实测 3420 行),新写法每账户一次点查。
  it("asOf():生产形状的 [t−7d, t] 窗口,读数与总数无关且 ≤ 账户数 × 3 + 常数", async () => {
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
