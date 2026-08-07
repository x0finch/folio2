// 让 `catalog:` 这条约定真的成立(#370)。
//
// catalog 本身**不强制**:pnpm 完全接受某个包手写 `"vitest": "^4.1.9"`,装出来也对,
// 于是收口在下一个新包那里就悄悄破了 —— 而这正是当初 5 处分叉的成因(没人是故意的)。
// 这个脚本是那条约定的执行者,两个方向各查一遍:
//
//   ① catalog 里已有的名字,任何包都不许再写版本号 —— 写了就是又开了一个可漂的点。
//   ② 被 ≥2 个包依赖的名字,必须在 catalog 里 —— 「加第二个消费者」正是该收口的时刻。
//
// `peerDependencies` 两个方向都跳过:peer 范围故意比 dev 宽(`@folio/ui` 的 `react: ^19.0.0`),
// 收进 catalog 会把「我能配合谁」收窄成「我装哪个」。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".wrangler", ".scratch", "drizzle"]);
const CHECKED_FIELDS = ["dependencies", "devDependencies"];

// pnpm-workspace.yaml 的 `catalog:` 块。手搓解析而不是引 `yaml` —— 形状是固定的两层缩进,
// 而为一个 20 行的检查脚本加一个根依赖,换来的只是同样的结果。
function readCatalog() {
  const lines = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.indexOf("catalog:");
  if (start < 0) throw new Error("pnpm-workspace.yaml 里没有 `catalog:` 块");
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    // 注释判断要在 trim 之后 —— 块内的注释总是缩进的,`line.startsWith("#")` 只认得顶格那种,
    // 于是 `  # 测试基础设施` 会被当成一个叫「# 测试基础设施」的依赖收进来。
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!line.startsWith("  ")) break; // 缩进结束 = 块结束
    const name = trimmed.split(":")[0];
    names.add(name.replace(/^["']|["']$/g, ""));
  }
  return names;
}

function findPackageJsons(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findPackageJsons(join(dir, entry.name), found);
    } else if (entry.name === "package.json") {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const catalog = readCatalog();
const errors = [];
const consumers = new Map(); // 依赖名 → 声明它的包路径

for (const file of findPackageJsons(ROOT)) {
  const where = relative(ROOT, file);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  for (const field of CHECKED_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) continue;
      if (catalog.has(name) && range !== "catalog:") {
        errors.push(`${where} → "${name}": "${range}" 应写 "catalog:"(版本在 catalog 里改)`);
      }
      if (!consumers.has(name)) consumers.set(name, []);
      consumers.get(name).push(where);
    }
  }
}

for (const [name, where] of consumers) {
  if (catalog.has(name) || where.length < 2) continue;
  errors.push(`"${name}" 被 ${where.length} 个包依赖(${where.join(", ")}),应收进 catalog`);
}

if (errors.length > 0) {
  console.error(`共享依赖版本没收口,${errors.length} 处:\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    "\n改法:版本写进 pnpm-workspace.yaml 的 `catalog:`,各包写 `catalog:`,再 pnpm install",
  );
  process.exit(1);
}

console.log(`catalog 收口正常:${catalog.size} 个依赖,${consumers.size} 个名字全部合规`);
