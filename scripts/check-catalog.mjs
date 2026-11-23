// Enforces the `catalog:` convention, which pnpm itself does not: a hand-written version in one package silently reopens drift. Two checks:
//
//   1) A name already in the catalog must not carry a version in any package.
//   2) A name depended on by 2+ packages must be in the catalog.
//
// `peerDependencies` are skipped both ways: peer ranges are deliberately wider than dev ranges.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  "dist",
  ".wrangler",
  ".scratch",
  "drizzle",
]);
const CHECKED_FIELDS = ["dependencies", "devDependencies"];

// The `catalog:` block of pnpm-workspace.yaml, parsed by hand (a fixed two-level shape isn't worth a `yaml` dependency).
function readCatalog() {
  const lines = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.indexOf("catalog:");
  if (start < 0) throw new Error("no `catalog:` block in pnpm-workspace.yaml");
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    // Test for comments after trim: in-block comments are indented, so `startsWith("#")` would miss them and read them as dependency names.
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!line.startsWith("  ")) break; // end of indentation = end of block
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
const consumers = new Map(); // dependency name -> package paths declaring it

for (const file of findPackageJsons(ROOT)) {
  const where = relative(ROOT, file);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  for (const field of CHECKED_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (range.startsWith("workspace:")) continue;
      if (catalog.has(name) && range !== "catalog:") {
        errors.push(
          `${where} -> "${name}": "${range}" should be "catalog:" (change the version in the catalog)`,
        );
      }
      if (!consumers.has(name)) consumers.set(name, []);
      consumers.get(name).push(where);
    }
  }
}

for (const [name, where] of consumers) {
  if (catalog.has(name) || where.length < 2) continue;
  errors.push(
    `"${name}" is depended on by ${where.length} packages (${where.join(", ")}); move it into the catalog`,
  );
}

if (errors.length > 0) {
  console.error(`Shared dependency versions not in the catalog, ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    "\nFix: put the version in the catalog: of pnpm-workspace.yaml, write `catalog:` in each package, then pnpm install",
  );
  process.exit(1);
}

console.log(`catalog OK: ${catalog.size} dependencies, all ${consumers.size} names compliant`);
