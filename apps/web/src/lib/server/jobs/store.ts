// Job ledger in the runner DO's SQLite. Takes a minimal SQL interface so tests run the same SQL on
// `node:sqlite`.
// Each method is atomic (sync SQL API); calls between methods are not: enqueue / poke RPCs can
// interleave while a job awaits I/O. Safe today since they never modify claimed rows — keep it so.

export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): unknown[] };
}

/** `attempts` already includes this claim (1-based). */
interface ClaimedJob {
  readonly id: number;
  readonly body: string;
  readonly attempts: number;
}

interface NewJob {
  readonly body: string;
  readonly runAt: number;
}

export interface JobStore {
  add(jobs: readonly NewJob[]): void;
  /**
   * Claims one due job: bumps attempts and pushes `run_at` by the lease. Counting before running
   * lets the runner recognise a final attempt that died mid-run.
   */
  claimNext(now: number, leaseMs: number): ClaimedJob | null;
  done(id: number): void;
  retryAt(id: number, runAt: number, error: string): void;
  /** Kept for inspection, never claimed again. */
  bury(id: number, now: number, error: string): void;
  nextRunAt(): number | null;
  pruneDead(before: number): void;
  counts(): { pending: number; dead: number };
  /** Alarm time we last set; unlike `getAlarm()` it is not null while an alarm runs. */
  alarmAt(): number | null;
  /** Call only when an alarm was actually set. */
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
  "CREATE INDEX IF NOT EXISTS jobs_due ON jobs (dead_at, run_at, id)",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
];

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
