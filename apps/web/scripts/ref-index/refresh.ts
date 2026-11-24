// Refreshes `global_token_ref_index` (on-chain contract to CoinGecko name). It doesn't run in the Worker: the pass costs 480-520ms CPU against the free plan's 10ms.
//
//   pnpm --filter @folio/web ref-index:refresh               # remote D1 (needs CLOUDFLARE_API_TOKEN)
//   pnpm --filter @folio/web ref-index:refresh --dry-run     # compute the diff against remote, write nothing
//   pnpm --filter @folio/web ref-index:refresh --env preview # the preview DB in wrangler.jsonc
//   pnpm --filter @folio/web ref-index:local                 # the local D1 behind `pnpm dev` (.wrangler/state)
//
// Scheduled by `.github/workflows/ref-index-refresh.yml` (daily 23:00 UTC).
//
// Env:
//   CLOUDFLARE_API_TOKEN   required for remote (Account > D1 > Edit; the deploy token has it). Only in request headers, never printed.
//   COINGECKO_API_KEY      optional; enables pro/demo quota
//   COINGECKO_API_BASE     optional; upstream base override (perf tests point it at a local fake)
//
// Exit codes: 0 success; 1 failure (upstream / D1 / arguments).
import { join } from "node:path";
import { parseArgs } from "node:util";
import { coinGeckoConfigOf } from "@/lib/server/coingecko-config";
import { createD1HttpSql } from "./d1-http";
import { refreshRefIndex, tallied } from "./job";
import { openSqliteFile, resolveLocalDb } from "./sqlite-file";

const WEB_ROOT = join(import.meta.dirname, "..", "..");
const WRANGLER_CONFIG = join(WEB_ROOT, "wrangler.jsonc");
// The `test` env's database_id in wrangler.jsonc doesn't exist on Cloudflare; it's for local use only.
const LOCAL_ONLY_ENVS = new Set(["test"]);

const USAGE = `usage: ref-index:refresh [--dry-run] [--env <wrangler env>] [--local <sqlite file | persist dir>]
  --dry-run   compute the diff and print the counts; send no writes
  --env       wrangler environment whose D1 to target (default: top level = production)
  --local     write to a local SQLite file instead of remote D1; a directory is searched for
              Miniflare's D1 files (e.g. .wrangler/state)`;

const log = (msg: string) => process.stderr.write(`[ref-index] ${msg}\n`);

function parseOptions(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      env: { type: "string" },
      local: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    help: values.help,
    dryRun: values["dry-run"],
    env: values.env,
    local: values.local,
  };
}

// Target to transport: remote needs the token; local is a SQLite file. `./target` loads lazily because it pulls in all of wrangler (~1s).
async function openTarget(opts: ReturnType<typeof parseOptions>) {
  if (opts.local !== undefined) {
    const path = resolveLocalDb(opts.local);
    const file = openSqliteFile(path);
    return { label: `local ${path}`, sql: file.sql, close: file.close };
  }
  if (opts.env && LOCAL_ONLY_ENVS.has(opts.env)) {
    throw new Error(`env "${opts.env}" has no remote D1 — use --local`);
  }
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set (needed for remote D1)");
  const { readD1Target } = await import("./target");
  const target = readD1Target(WRANGLER_CONFIG, opts.env);
  return {
    label: `remote D1 ${target.databaseName} (${target.databaseId})`,
    sql: createD1HttpSql({ ...target, token }),
    close: () => {},
  };
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) return void console.log(USAGE);

  const target = await openTarget(opts);
  const { sql, tally } = tallied(target.sql, opts.dryRun);
  const started = Date.now();
  log(`${opts.dryRun ? "dry run against" : "refreshing"} ${target.label}`);
  try {
    const report = await refreshRefIndex(sql, coinGeckoConfigOf(process.env));
    const lines = {
      lastRefreshedAt:
        report.lastRefreshedAt === null ? "never" : new Date(report.lastRefreshedAt).toISOString(),
      rows: report.rows,
      skipped: report.skipped,
      unmatchedPlatforms: report.unmatchedPlatforms.length,
      inserted: report.inserted,
      updated: report.updated,
      deleted: report.deleted,
      reads: tally.reads,
      [opts.dryRun ? "writesPlanned" : "writes"]:
        `${tally.writeStatements} statements in ${tally.writeBatches} batches`,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
    };
    for (const [k, v] of Object.entries(lines)) console.log(`${k}: ${v}`);
    // A chain-map mismatch is a silent failure (that chain's tokens get no price or logo): surface it as a warning in Actions.
    if (report.unmatchedPlatforms.length > 0) {
      const list = report.unmatchedPlatforms.join(", ");
      if (process.env.GITHUB_ACTIONS === "true")
        console.log(`::warning::unmatched platforms: ${list}`);
      else log(`unmatched platforms: ${list}`);
    }
  } finally {
    target.close();
  }
}

main().catch((err: unknown) => {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
