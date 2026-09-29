import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RemoteSql } from "@folio/db";

// 本机 SQLite 文件当作一条 SQL 传输(FOL-85)。两个用处:
//   · 本地开发:`pnpm --filter @folio/web ref-index:local` 把 `pnpm dev` 那个本地 D1 灌满
//     (以前是 curl 那个 23:00 的 cron,刷表挪出 Worker 之后那条路就没了);
//   · perf 压测:sweep 要一张非空的映射表才认得出链上的币(`scripts/perf/jobs.mjs`)。
// 以及 `--dry-run` 对着一份本地库算差量(看「这一轮会写几行」而不碰远端)。
//
// 语义对齐 D1:`batch` 是一个事务、按序执行、任何一条失败整批回滚。

/** Miniflare 把本地 D1 放在 `<persist 目录>/v3/d1/miniflare-D1DatabaseObject/<散列>.sqlite`。 */
const MINIFLARE_D1_SUBDIR = join("v3", "d1", "miniflare-D1DatabaseObject");
const REF_INDEX_TABLE = "global_token_ref_index";

const hasRefIndexTable = (path: string): boolean => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db
        .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
        .get(REF_INDEX_TABLE) !== undefined
    );
  } finally {
    db.close();
  }
};

/**
 * `--local` 的参数 → 那个 SQLite 文件。给文件就用文件;给目录(如 `.wrangler/state`)就在 Miniflare
 * 的 D1 目录里找**唯一一个**建过映射表的库。文件名是 database_id 的散列,不写死;找到多个
 * (dev 与 e2e 共用一个 persist 目录)就报错列出来,让调用方指名 —— 猜错了会灌进别的库。
 */
export function resolveLocalDb(target: string): string {
  if (!existsSync(target)) throw new Error(`--local: ${target} does not exist`);
  if (statSync(target).isFile()) return target;
  const dir = existsSync(join(target, MINIFLARE_D1_SUBDIR))
    ? join(target, MINIFLARE_D1_SUBDIR)
    : target;
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    .map((f) => join(dir, f))
    .filter(hasRefIndexTable);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(
      `--local: no migrated D1 under ${dir} (run \`pnpm --filter @folio/web db:migrate:local\` first)`,
    );
  }
  throw new Error(
    `--local: several D1 files under ${dir}, pass one of:\n  ${candidates.join("\n  ")}`,
  );
}

export function openSqliteFile(path: string): { sql: RemoteSql; close: () => void } {
  const db = new DatabaseSync(path);
  // 值数组(列按 SELECT 顺序),与 D1 `/raw` 同形。`run` 的语句不看结果。
  const exec = (sql: string, params: readonly unknown[], method: string): unknown[][] => {
    const stmt = db.prepare(sql);
    const args = params as SQLInputValue[];
    if (method === "run") {
      stmt.run(...args);
      return [];
    }
    stmt.setReturnArrays(true);
    return stmt.all(...args) as unknown as unknown[][];
  };
  return {
    sql: {
      query: async (s) => exec(s.sql, s.params, s.method),
      batch: async (stmts) => {
        db.exec("BEGIN");
        try {
          const out = stmts.map((s) => exec(s.sql, s.params, s.method));
          db.exec("COMMIT");
          return out;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      },
    },
    close: () => db.close(),
  };
}
