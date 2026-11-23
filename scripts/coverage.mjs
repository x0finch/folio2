// Repo-wide line coverage: one command, one number.
//
//   pnpm coverage            # run the three passes, merge, print the table (HTML in coverage/index.html)
//   pnpm coverage --no-run   # only merge the coverage-final.json files left by the last run
//   pnpm coverage --min 80   # exit non-zero when repo-wide line coverage is below 80% (CI)
//
// Three passes then a merge, since apps/web has its own config (`@/` alias, per-extension environments) that the root projects can't absorb:
//   1) packages (root `test.projects`, including packages/db's workers pool)
//   2) apps/web unit tests (logic + dom projects)
//   3) apps/web server tests (workers pool, tests/server/**)
// Each pass emits raw istanbul data merged per file; hits for a file covered by two passes add up.
//
// istanbul, not v8: workers pools run in workerd with no `node:inspector`, and istanbul counts never-loaded files in the denominator (v8 drops them and inflates the number).

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

// Excluded: code that isn't ours or isn't executable logic. Think before adding one; don't use this to pad the number.
const EXCLUDE = [
  "**/node_modules/**",
  "**/tests/**",
  "**/*.test.{ts,tsx}",
  "**/*.d.ts",
  // Vendored beUI / shadcn components, not our code.
  "packages/ui/src/components/**",
  "**/routeTree.gen.ts", // TanStack Router generated
  "**/drizzle/**", // migration SQL and drizzle-kit output
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

// apps/web paths resolve against its own root; root-style exclusions are harmless there and the wildcard ones hold for both.
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
    // Stop on red tests: coverage measured from failing tests is meaningless.
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

const map = libCoverage.createCoverageMap({});
for (const run of RUNS) {
  const file = join(OUT, "runs", run.name, "coverage-final.json");
  if (!existsSync(file)) {
    console.error(`[coverage] missing ${relative(ROOT, file)}; run once without --no-run first`);
    process.exit(1);
  }
  map.merge(JSON.parse(readFileSync(file, "utf8")));
}

const context = libReport.createContext({ dir: OUT, coverageMap: map });
reports.create("html").execute(context);
reports.create("json-summary").execute(context);

// Summarised by area: packages by the segment before `packages/<...>/src`, apps/web by two levels under src.
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
console.log("\nArea (by uncovered lines)                  Lines  Cover  Uncovered");
for (const [area, a] of [...areas].sort(
  (x, y) => y[1].total - y[1].covered - (x[1].total - x[1].covered),
)) {
  if (a.total === 0) continue;
  console.log(
    `${area.padEnd(40)} ${String(a.total).padStart(6)} ${pct(a.covered, a.total).toFixed(1).padStart(6)}% ${String(a.total - a.covered).padStart(7)}`,
  );
}
const total = map.getCoverageSummary().lines;
console.log(`\nRepo-wide line coverage: ${total.pct}% (${total.covered} / ${total.total})`);
console.log(`HTML report: ${relative(ROOT, join(OUT, "index.html"))}`);

// The gate looks only at the repo-wide total, not per package: a thin small package shouldn't hold back the whole.
const minAt = process.argv.indexOf("--min");
if (minAt !== -1) {
  const min = Number(process.argv[minAt + 1]);
  if (!Number.isFinite(min)) {
    console.error("[coverage] --min needs a percentage, e.g. --min 80");
    process.exit(1);
  }
  if (total.pct < min) {
    console.error(
      `[coverage] repo-wide line coverage ${total.pct}% is below the threshold ${min}%`,
    );
    process.exit(1);
  }
}
