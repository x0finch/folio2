// 清空共享 preview 库(方案 B 的兜底):drop 所有业务表 + d1_migrations,好让紧接着的
// `db:migrate:preview` 从零全量重建 schema。只碰 folio-preview(env.preview),**永不碰生产**。
// 由 .github/workflows/preview-reset.yml 手动触发调用。
//
// ⚠️ drop-all 尚未在真 D1 上验证过 —— 首次运行盯日志确认 drop 段没报 FK/PRAGMA 错、且
// `wrangler … --json` 解析干净;失败按 DEPLOY.md「PR preview」的手动兜底(delete + create)处理。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// 通过 pnpm script 调用时,apps/web/node_modules/.bin 已在 PATH,直接跑 `wrangler` 即可。
const BASE = ["d1", "execute", "folio-preview", "--remote", "--env", "preview"];

function wrangler(args) {
  return execFileSync("wrangler", args, { encoding: "utf8" });
}

// 查出所有业务表(排除 SQLite 内部表和 D1 的 _cf_ 表)。d1_migrations 也一并 drop,让全量迁移重跑。
const raw = wrangler([
  ...BASE,
  "--json",
  "--command",
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
]);

// wrangler --json 可能夹带非 JSON 的横幅行 → 截取第一个 [ 到最后一个 ] 再解析。
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

// 一个 execute 里先关 FK 再逐个 drop,避开父子表删除顺序问题。
const sql = ["PRAGMA foreign_keys=OFF;", ...tables.map((t) => `DROP TABLE IF EXISTS "${t}";`)].join(
  "\n",
);
const sqlPath = "/tmp/reset-preview.sql";
writeFileSync(sqlPath, sql);
console.log(`dropping ${tables.length} table(s):\n${sql}`);
wrangler([...BASE, "--file", sqlPath]);
console.log("done — tables dropped; run db:migrate:preview to rebuild");
