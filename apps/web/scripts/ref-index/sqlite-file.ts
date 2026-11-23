import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { RemoteSql } from "@folio/db";

// A local SQLite file as a SQL transport, for local dev (`ref-index:local` fills the D1 behind `pnpm dev`), perf tests (sweep needs a non-empty map to recognise on-chain tokens), and `--dry-run` against a local copy.
//
// Same semantics as D1: `batch` is one transaction, run in order, rolling back on any failure.

/** Miniflare keeps the local D1 at `<persist dir>/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`. */
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

/** The `--local` argument to a SQLite file: a file is used as-is; a directory (e.g. `.wrangler/state`) is searched for the single Miniflare D1 that has the map table (file names are database_id hashes). Several matches (dev and e2e share a persist dir) is an error listing them, since guessing would fill another DB. */
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
  // Value arrays (columns in SELECT order), same shape as D1 `/raw`. `run` statements ignore results.
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
