import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-text helpers for the loader tests: they pin what each page fetches (and that nothing is
// awaited) by inspecting source, not runtime behaviour.

const ROOT = join(import.meta.dirname, "../../src");
const PREFETCH = "lib/queries/prefetch-pages.ts";

export function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function functionSlice(all: string, name: string): string | null {
  const m = new RegExp(`(?:export )?function ${name}\\(`).exec(all);
  if (!m) return null;
  const rest = all.slice(m.index + m[0].length);
  const next = rest.search(/\n(?:export )?function /);
  return next < 0 ? all.slice(m.index) : all.slice(m.index, m.index + m[0].length + next);
}

// Slice out one page's prefetch body (all pages share one file, so a sibling's fetch would otherwise
// satisfy `not.toContain`), plus the non-exported helpers it calls. Throws rather than return empty.
export function prefetchBody(name: string): string {
  const all = stripComments(readSrc(PREFETCH));
  const own = functionSlice(all, name);
  if (!own) throw new Error(`${name} not found in prefetch-pages.ts`);
  const helpers = [...own.matchAll(/\b([a-z]\w*)\(queryClient/g)]
    .map((m) => m[1])
    .filter((id, i, arr) => id !== name && arr.indexOf(id) === i)
    .map((id) => functionSlice(all, id))
    .filter((slice): slice is string => slice != null && !slice.startsWith("export "));
  return [own, ...helpers].join("\n");
}
