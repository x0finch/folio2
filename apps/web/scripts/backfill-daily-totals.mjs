// Reruns the daily-rollup backfill: recomputes `account_daily_totals` from all snapshots.
//
// The backfill runs once inside migration 0009, but release order is migrate then deploy, and old code writing snapshots in between doesn't maintain the rollup; rerun after deploy to fill them in.
//
// The statement is read from the migration file (no copy to drift); INSERT OR REPLACE is idempotent and a single D1 statement is atomic, so it doesn't race new code.
//
// Usage (in apps/web): `pnpm run db:backfill-daily-totals` (default --remote); other args pass through to `wrangler d1 execute folio`, e.g. `-- --local`.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../../packages/db/drizzle/", import.meta.url);
const file = readdirSync(dir).find((f) => /^\d+_account_daily_totals\.sql$/.test(f));
if (!file) {
  console.error("account_daily_totals migration not found in packages/db/drizzle");
  process.exit(1);
}
const statement = readFileSync(new URL(file, dir), "utf8")
  .split("--> statement-breakpoint")
  .find((s) => s.includes("INSERT OR REPLACE"));
if (!statement) {
  console.error(`no INSERT OR REPLACE backfill in ${file}`);
  process.exit(1);
}
// Comment lines contain semicolons and `--command` splits on them: strip comments and keep only the one SQL statement.
const sql = statement
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .trim();

const passthrough = process.argv.slice(2).filter((a) => a !== "--");
const target = passthrough.some((a) => a === "--local" || a === "--remote") ? [] : ["--remote"];

// Run via a pnpm script, apps/web/node_modules/.bin is on PATH, so call `wrangler` directly.
execFileSync(
  "wrangler",
  ["d1", "execute", "folio", ...target, ...passthrough, "--yes", "--command", sql],
  { stdio: "inherit" },
);
