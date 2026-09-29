// 刷 `global_token_ref_index`(链上合约 → CoinGecko 的叫法,ADR 0022)。FOL-85 起它不在 Worker 里跑了
// —— 那一趟拉 2.6 MB、比对几万行,生产 480–520ms CPU,而免费计划一次调用只有 10ms(ADR 0056)。
//
//   pnpm --filter @folio/web ref-index:refresh               # 远端 D1(要 CLOUDFLARE_API_TOKEN)
//   pnpm --filter @folio/web ref-index:refresh --dry-run     # 对着远端算差量,一行不写
//   pnpm --filter @folio/web ref-index:refresh --env preview # wrangler.jsonc 里 preview 那个库
//   pnpm --filter @folio/web ref-index:local                 # 本地 `pnpm dev` 那个 D1(.wrangler/state)
//
// 定时跑的是 `.github/workflows/ref-index-refresh.yml`(每天 23:00 UTC)。
//
// 环境变量:
//   CLOUDFLARE_API_TOKEN   远端必需(Account › D1 › Edit;部署用的那把已经有)。**只进请求头,从不打印。**
//   COINGECKO_API_KEY      可选;设了走 pro/demo 额度
//   COINGECKO_API_BASE     可选;上游基址覆盖(perf 压测指到本机假上游),与 Worker 同一套读法
//
// 退出码:0 成功;1 失败(上游 / D1 / 参数)。
import { join } from "node:path";
import { parseArgs } from "node:util";
import { coinGeckoConfigOf } from "@/lib/server/coingecko-config";
import { createD1HttpSql } from "./d1-http";
import { refreshRefIndex, tallied } from "./job";
import { openSqliteFile, resolveLocalDb } from "./sqlite-file";

const WEB_ROOT = join(import.meta.dirname, "..", "..");
const WRANGLER_CONFIG = join(WEB_ROOT, "wrangler.jsonc");
// wrangler.jsonc 里 `test` 那个 env 的 database_id 在 Cloudflare 上并不存在,只配本地用(见那里的注释)。
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

// 目标 → 传输。远端要 token;本地是一个 SQLite 文件。
// `./target` 按需才加载:它拉起整个 wrangler(约 1s),本地那条路用不着。
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
    // 链对照失配是静默故障(那条链的币从此没价没图,却不报错)—— 在 Actions 里标成 warning,运行页一眼可见。
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
