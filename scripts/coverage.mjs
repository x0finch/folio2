// 全仓行覆盖率(FOL-103):一条命令、一个数。
//
//   pnpm coverage            # 跑三趟测试 + 合并 + 打总表(HTML 在 coverage/index.html)
//   pnpm coverage --no-run   # 只合并上一次各趟留下的 coverage-final.json
//
// **为什么是三趟、再合并**,而不是一份 vitest 配置跑到底:
//   ① 各包(根目录的 `test.projects`,含 packages/db 的 workers 池)
//   ② apps/web 的单测(logic + dom 两个 project)
//   ③ apps/web 的服务端测试(workers 池,tests/server/**)
// apps/web 有自己的配置(`@/` 别名、按扩展名分环境),根目录的 projects 收不进来;②③ 又是两份配置,
// CI 本来也是分开跑的。三趟各出一份 istanbul 原始数据,在这里按文件合并 —— 同一个源文件被两趟都
// 跑到时命中次数相加,结果与一趟跑完相同。
//
// **为什么是 istanbul 不是 v8**:workers 池跑在 workerd 里,没有 `node:inspector`,v8 那条路直接报错;
// 而且 istanbul 会把**一次都没被测试加载过**的源文件也算进分母(按 `include` 收),v8 那边这类文件
// 会被记成 0 行、从分母里消失,数字虚高(实测 apps/web 那一份就虚高)。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "coverage");
const WEB = join(ROOT, "apps/web");

// **不计入**的:不是我们写的、或者不是可执行逻辑的。新增一类排除先想清楚它是不是真的「不该测」,
// 别拿这里给数字注水。
const EXCLUDE = [
  "**/node_modules/**",
  "**/tests/**",
  "**/*.test.{ts,tsx}",
  "**/*.d.ts",
  // beUI / shadcn registry 拷进来的件(CLAUDE.md 原则 11:不改件内核)—— 不是我们的代码。
  "packages/ui/src/components/**",
  "**/routeTree.gen.ts", // TanStack Router 生成
  "**/drizzle/**", // 迁移 SQL 与 drizzle-kit 产物
];

const RUNS = [
  { name: "packages", cwd: ROOT, args: [], include: "packages/**/src/**" },
  { name: "web", cwd: WEB, args: [], include: "src/**" },
  {
    name: "web-server",
    cwd: WEB,
    args: ["--config", "vitest.workers.config.ts"],
    include: "src/**",
  },
];

// apps/web 的路径按它自己的根算:根目录的排除写法(`packages/ui/...`)对它无害,通配那几条对两边都成立。
const flags = (run) => [
  "--coverage.enabled",
  "--coverage.provider=istanbul",
  "--coverage.reporter=json",
  `--coverage.reportsDirectory=${join(OUT, "runs", run.name)}`,
  `--coverage.include=${run.include}`,
  ...EXCLUDE.map((p) => `--coverage.exclude=${p}`),
];

if (!process.argv.includes("--no-run")) {
  rmSync(OUT, { recursive: true, force: true });
  for (const run of RUNS) {
    console.log(`\n[coverage] ${run.name}`);
    const r = spawnSync("pnpm", ["exec", "vitest", "run", ...run.args, ...flags(run)], {
      cwd: run.cwd,
      stdio: "inherit",
    });
    // 测试红了就停:红着的测试量出来的覆盖率没有意义。
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

const map = libCoverage.createCoverageMap({});
for (const run of RUNS) {
  const file = join(OUT, "runs", run.name, "coverage-final.json");
  if (!existsSync(file)) {
    console.error(`[coverage] 缺 ${relative(ROOT, file)} —— 先跑一次不带 --no-run 的`);
    process.exit(1);
  }
  map.merge(JSON.parse(readFileSync(file, "utf8")));
}

const context = libReport.createContext({ dir: OUT, coverageMap: map });
reports.create("html").execute(context);
reports.create("json-summary").execute(context);

// 按区域汇总:包按 `packages/<…>/src` 之前那段,apps/web 按 src 下两层。
const areaOf = (file) => {
  const rel = relative(ROOT, file);
  const pkg = rel.match(/^packages\/(.+?)\/src\//);
  if (pkg) return `packages/${pkg[1]}`;
  const web = rel.match(/^apps\/web\/src\/([^/]+(?:\/[^/]+)?)\//);
  return web ? `web/${web[1]}` : rel;
};
const areas = new Map();
for (const file of map.files()) {
  const lines = map.fileCoverageFor(file).toSummary().lines;
  const a = areas.get(areaOf(file)) ?? { total: 0, covered: 0 };
  a.total += lines.total;
  a.covered += lines.covered;
  areas.set(areaOf(file), a);
}

const pct = (c, t) => (t === 0 ? 100 : (100 * c) / t);
console.log("\n区域(按未覆盖行数排序)                    行数   覆盖   未覆盖");
for (const [area, a] of [...areas].sort(
  (x, y) => y[1].total - y[1].covered - (x[1].total - x[1].covered),
)) {
  if (a.total === 0) continue;
  console.log(
    `${area.padEnd(40)} ${String(a.total).padStart(6)} ${pct(a.covered, a.total).toFixed(1).padStart(6)}% ${String(a.total - a.covered).padStart(7)}`,
  );
}
const total = map.getCoverageSummary().lines;
console.log(`\n全仓行覆盖:${total.pct}%(${total.covered} / ${total.total})`);
console.log(`HTML 报告:${relative(ROOT, join(OUT, "index.html"))}`);
