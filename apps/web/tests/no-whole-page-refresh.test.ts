import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guard: no whole-page refresh in apps/web/src. A missed targeted refresh fails silently, and
// `router.invalidate` cannot refresh migrated domains (`ensureQueryData` ignores staleness).
// Both `.invalidate(` and `useRouter(` are banned (destructuring `invalidate` would slip past).
// Comments are stripped first so prose mentioning the call does not trip the guard.
const SRC = join(import.meta.dirname, "../src");

const BANNED = [".invalidate(", "useRouter("] as const;

// Strip comments. `//` after a colon is not a comment start, or URLs would hide violations.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

describe("Whole-page refresh is gone", () => {
  it("apps/web/src has no router.invalidate and never obtains the router instance", () => {
    const offenders = [...walk(SRC)].flatMap((f) => {
      const code = stripComments(readFileSync(f, "utf8"));
      const hits = BANNED.filter((needle) => code.includes(needle));
      return hits.length > 0 ? [`${f.slice(SRC.length + 1)} → ${hits.join(", ")}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  // Guard the guard: a broken strip regex would make the test above vacuously green.
  it("after stripping comments still catches code violations, without flagging comments or URLs", () => {
    expect(stripComments("const r = useRouter();").includes("useRouter(")).toBe(true);
    expect(stripComments("// no router.invalidate() here").includes(".invalidate(")).toBe(false);
    expect(
      stripComments('const u = "https://x.dev"; r.invalidate();').includes(".invalidate("),
    ).toBe(true);
  });
});
