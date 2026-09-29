// 重跑日汇总回填(review #10):把 `account_daily_totals` 按全部快照整张重算一遍。
//
// 为什么要有它:回填写在迁移 0009 里,只在迁移那一刻跑一次;而发版顺序是「先迁移、再部署」,
// 中间那几分钟旧代码还在写快照(整点 cron / 手点同步),旧代码不维护日汇总 —— 那几张快照就永远
// 进不了汇总(除非同一天同一钟点后来又被折叠重算)。部署完再跑一次就补齐了。
//
// 语句**直接从迁移文件里取**,不另抄一份:两边不会漂。`INSERT OR REPLACE` 幂等,随时可重跑;
// 一条语句在 D1 里是原子的,和新代码的并发写不打架。
//
// 用法(在 apps/web 下):`pnpm run db:backfill-daily-totals`(默认 --remote);
// 其余参数原样传给 `wrangler d1 execute folio`,如 `-- --local`。
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
// 注释行里有分号,`--command` 会按分号切语句 → 去掉注释行,只留那一条 SQL。
const sql = statement
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .trim();

const passthrough = process.argv.slice(2).filter((a) => a !== "--");
const target = passthrough.some((a) => a === "--local" || a === "--remote") ? [] : ["--remote"];

// 通过 pnpm script 调用时,apps/web/node_modules/.bin 已在 PATH,直接跑 `wrangler` 即可。
execFileSync(
  "wrangler",
  ["d1", "execute", "folio", ...target, ...passthrough, "--yes", "--command", sql],
  { stdio: "inherit" },
);
