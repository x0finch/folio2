import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pin / unpin / retarget must wait until the tab bar actually changes. The bar is precomputed in
// `waitUntil`, so the immediate refetch often returns the old bar: `selectTab` on a missing id
// does nothing, and a retarget shows the old name. Reads source because running these mutation
// callbacks would need router + queryClient + real server fns.

const SRC = join(import.meta.dirname, "../src/routes/_authed/-home/tab/pin.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("pin writes wait for the tab bar", () => {
  const src = () => stripComments(readFileSync(SRC, "utf8"));

  it("each of the three writes waits once", () => {
    // create / delete / updateTarget: each onSuccess must contain the wait.
    expect(src().match(/await awaitStrip\(/g) ?? []).toHaveLength(3);
  });

  it("the new Tab is selected only after it appears, not right after a refetch", () => {
    const s = src();
    const wait = s.indexOf("await awaitStrip", s.indexOf("createTabPin"));
    const select = s.indexOf("selectTab(pin.id)", s.indexOf("createTabPin"));
    expect(wait).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(wait);
  });
});
