import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

//
//
//

const COMPONENTS = join(import.meta.dirname, "../src/components");
const HOME = join(import.meta.dirname, "../src/routes/_authed/-home");

function filesRendering(tag: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const dir of [COMPONENTS, HOME]) {
    for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!rel.endsWith(".tsx")) continue;
      const text = stripLineComments(readFileSync(join(dir, rel), "utf8"));
      if (text.includes(`<${tag}`)) out.push({ file: rel.replaceAll("\\", "/"), text });
    }
  }
  return out;
}

function stripLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

function renderBlocks(text: string, tag: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = text.indexOf(`<${tag}`, from);
    if (start === -1) break;
    const end = text.indexOf("/>", start);
    blocks.push(text.slice(start, end === -1 ? text.length : end));
    from = start + 1;
  }
  return blocks;
}

// Structural scan: a missing gain24h silently hides the delta row, so every render path must pass it.
describe("every <TokenRowContent> render path must pass 24h P&L", () => {
  const users = filesRendering("TokenRowContent");

  it("all three paths exist (if one is missing the test premise is stale)", () => {
    expect(users.map((u) => u.file).sort()).toEqual([
      "holdings-cards.tsx",
      "holdings/tokens/index.tsx",
      "manual-tokens-panel.tsx",
    ]);
  });

  it.each(users.map((u) => u.file))("%s passes gain24h", (file) => {
    const { text } = users.find((u) => u.file === file) as (typeof users)[number];
    for (const block of renderBlocks(text, "TokenRowContent")) {
      expect(block, `${file} <TokenRowContent> is missing gain24h`).toContain("gain24h");
    }
  });

  it("and `?? null` must not flatten the three states", () => {
    for (const { file, text } of users) {
      for (const block of renderBlocks(text, "TokenRowContent")) {
        expect(block.replace(/\s+/g, " "), `${file} flattens the three gain24h states`).not.toMatch(
          /gain24h:\s*[^,}]*\?\?\s*null/,
        );
      }
    }
  });

  it("self-check: mentioning the component name in a comment is not a render site", () => {
    const commented = `// see the <TokenRowContent> note\nconst x = 1;`;
    expect(stripLineComments(commented)).not.toContain("<TokenRowContent");
  });

  it("self-check: this scan really catches a missed pass-through", () => {
    const bad = `<TokenRowContent item={{ value: 1, amount: 2 }} />`;
    expect(renderBlocks(bad, "TokenRowContent")[0]).not.toContain("gain24h");
    const flattened = `<TokenRowContent item={{ gain24h: b.gain24h ?? null }} />`;
    expect(renderBlocks(flattened, "TokenRowContent")[0].replace(/\s+/g, " ")).toMatch(
      /gain24h:\s*[^,}]*\?\?\s*null/,
    );
  });
});
