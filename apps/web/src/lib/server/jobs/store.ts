// **后台活的账本**(FOL-100,ADR 0058)—— 住在运行器那个 Durable Object 自带的 SQLite 里。
//
// 一张表、一行一件活:什么时候到点(`run_at`)、跑过几次(`attempts`)、埋了没有(`dead_at`)。
// 它就是以前那条 Cloudflare 队列的全部职责:排队、延迟、重试、死信。
//
// **只认一个最小的 SQL 接口**,不认 `SqlStorage`:生产递 DO 的 `ctx.storage.sql`,单测递一个
// `node:sqlite` 的内存库 —— 同一套 SQL 在真 SQLite 上跑,不靠假实现猜行为。
//
// **每个方法内部是原子的**(DO 的 SQL API 是同步的,一个方法里的几条语句之间不会有别的调用插进来),
// **方法之间不是**:alarm 在「领 → 跑 → 记下场」的「跑」那一段要等出网与 D1,DO 的输入闸只在存储
// await 时关着,这段时间里 `enqueue` / `poke` 的 RPC 照样会进来。它们今天只插新行、补 alarm,
// 不碰别人领走的那一行,所以没事 —— **以后加会改已有行的 RPC,要先想清楚这一段**。

/** DO 的 `SqlStorage` 里这里用得到的那一点。 */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): unknown[] };
}

/** 领到手的一件活。`attempts` 已经把这一次算进去了(从 1 起)。 */
interface ClaimedJob {
  readonly id: number;
  readonly body: string;
  readonly attempts: number;
}

/** 要排进去的一件:消息体(已序列化)+ 什么时候到点。 */
interface NewJob {
  readonly body: string;
  readonly runAt: number;
}

export interface JobStore {
  /** 排进去一批。 */
  add(jobs: readonly NewJob[]): void;
  /**
   * 领**一件**到点的活:次数 +1、到点时间推到 `now + leaseMs`(租期)。没有到点的 → `null`。
   *
   * 次数在**跑之前**就加上:跑到一半 DO 没了,这一次也算数,过了租期再领时已经是下一次 ——
   * 运行器据此认出「上一次是最后一次、却没跑完」,直接收尾埋掉(`runner.ts`),不会无限重来。
   */
  claimNext(now: number, leaseMs: number): ClaimedJob | null;
  /** 做完了:删掉。 */
  done(id: number): void;
  /** 失败了,`runAt` 再跑。 */
  retryAt(id: number, runAt: number, error: string): void;
  /** 次数用完:埋掉。行留着(给人看),不再被领。 */
  bury(id: number, now: number, error: string): void;
  /** 活着的活里最早的到点时间;一件都没有 → `null`。 */
  nextRunAt(): number | null;
  /** 删掉 `before` 之前埋的。 */
  pruneDead(before: number): void;
  /** 排着的 / 埋了的各几件 —— 戳一下时的自述。 */
  counts(): { pending: number; dead: number };
  /**
   * 运行器上一次**自己定**的 alarm 是几点(`noteAlarm` 记的)。不只靠 `getAlarm()`:alarm 跑的那段时间里
   * 它是 `null`,而这个值一直在 —— 「该响的点过去很久了、活还排着」就是卡住了(`durable.ts` 的 `poke`)。
   */
  alarmAt(): number | null;
  /** 记下刚定的 alarm 时刻。只在真的定了 alarm 时调 —— 没变化就不写。 */
  noteAlarm(at: number): void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    dead_at INTEGER,
    last_error TEXT
  )`,
  // 「下一件到点的活」与「最早到点时间」都按它走:活着的(dead_at 为空)按到点时间、再按先来后到。
  "CREATE INDEX IF NOT EXISTS jobs_due ON jobs (dead_at, run_at, id)",
  // 运行器的自述值(上一次自己定的 alarm 时刻),给 cron 的「卡住了没有」用。
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
];

/** `last_error` 只留一句话的长度 —— 那是给人看的,不是给程序解析的。 */
const ERROR_MAX_CHARS = 500;

const ALARM_AT_KEY = "alarm_at";

const rows = <T>(cursor: { toArray(): unknown[] }) => cursor.toArray() as T[];

export function createJobStore(sql: SqlLike): JobStore {
  for (const statement of SCHEMA) sql.exec(statement);

  return {
    add: (jobs) => {
      for (const job of jobs) {
        sql.exec("INSERT INTO jobs (body, run_at) VALUES (?, ?)", job.body, job.runAt);
      }
    },

    claimNext: (now, leaseMs) => {
      const [next] = rows<{ id: number; body: string; attempts: number }>(
        sql.exec(
          "SELECT id, body, attempts FROM jobs WHERE dead_at IS NULL AND run_at <= ? ORDER BY run_at, id LIMIT 1",
          now,
        ),
      );
      if (!next) return null;
      const attempts = next.attempts + 1;
      sql.exec(
        "UPDATE jobs SET attempts = ?, run_at = ? WHERE id = ?",
        attempts,
        now + leaseMs,
        next.id,
      );
      return { id: next.id, body: next.body, attempts };
    },

    done: (id) => {
      sql.exec("DELETE FROM jobs WHERE id = ?", id);
    },

    retryAt: (id, runAt, error) => {
      sql.exec(
        "UPDATE jobs SET run_at = ?, last_error = ? WHERE id = ?",
        runAt,
        error.slice(0, ERROR_MAX_CHARS),
        id,
      );
    },

    bury: (id, now, error) => {
      sql.exec(
        "UPDATE jobs SET dead_at = ?, last_error = ? WHERE id = ?",
        now,
        error.slice(0, ERROR_MAX_CHARS),
        id,
      );
    },

    nextRunAt: () => {
      const [row] = rows<{ at: number | null }>(
        sql.exec("SELECT MIN(run_at) AS at FROM jobs WHERE dead_at IS NULL"),
      );
      return row?.at ?? null;
    },

    pruneDead: (before) => {
      sql.exec("DELETE FROM jobs WHERE dead_at IS NOT NULL AND dead_at < ?", before);
    },

    counts: () => {
      const [row] = rows<{ pending: number; dead: number }>(
        sql.exec(
          "SELECT COUNT(*) FILTER (WHERE dead_at IS NULL) AS pending, COUNT(*) FILTER (WHERE dead_at IS NOT NULL) AS dead FROM jobs",
        ),
      );
      return { pending: row?.pending ?? 0, dead: row?.dead ?? 0 };
    },

    alarmAt: () => {
      const [row] = rows<{ value: number }>(
        sql.exec("SELECT value FROM meta WHERE key = ?", ALARM_AT_KEY),
      );
      return row?.value ?? null;
    },

    noteAlarm: (at) => {
      sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ALARM_AT_KEY,
        at,
      );
    },
  };
}
