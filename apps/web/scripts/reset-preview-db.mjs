// Wipes the shared preview DB (fallback): drops all business tables + d1_migrations so the following `db:migrate:preview` rebuilds the schema from scratch. Touches only folio-preview (env.preview), never production. Run manually via .github/workflows/preview-reset.yml.
//
// Unverified on real D1: on the first run, check that the drop block hits no FK/PRAGMA error and `wrangler ... --json` parses cleanly; otherwise use DEPLOY.md's manual fallback (delete + create).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Run via a pnpm script, apps/web/node_modules/.bin is on PATH, so call `wrangler` directly.
const BASE = ["d1", "execute", "folio-preview", "--remote", "--env", "preview"];

function wrangler(args) {
  return execFileSync("wrangler", args, { encoding: "utf8" });
}

// All business tables (excluding SQLite internals and D1's _cf_ tables); d1_migrations is dropped too so the full migration reruns.
const raw = wrangler([
  ...BASE,
  "--json",
  "--command",
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
]);

// wrangler --json may carry non-JSON banner lines: parse from the first [ to the last ].
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
if (start === -1 || end === -1) {
  console.error("could not find JSON array in wrangler output:\n", raw);
  process.exit(1);
}
const parsed = JSON.parse(raw.slice(start, end + 1));
const tables = (parsed[0]?.results ?? []).map((r) => r.name);

if (tables.length === 0) {
  console.log("preview DB already empty — nothing to drop");
  process.exit(0);
}

// Turn FK off first in one execute, then drop each, to dodge parent/child ordering.
const sql = ["PRAGMA foreign_keys=OFF;", ...tables.map((t) => `DROP TABLE IF EXISTS "${t}";`)].join(
  "\n",
);
const sqlPath = "/tmp/reset-preview.sql";
writeFileSync(sqlPath, sql);
console.log(`dropping ${tables.length} table(s):\n${sql}`);
wrangler([...BASE, "--file", sqlPath]);
console.log("done — tables dropped; run db:migrate:preview to rebuild");
