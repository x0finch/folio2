import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

//
//
const SRC = join(import.meta.dirname, "../src");

const ALLOWED = ["components/icon-button.tsx"];

const SQUARE = /\bsize-[6-9]\b|\bh-([6-9])\s+w-\1\b/;
const HOVER_BG = /hover:bg-/;
const BOXY_RADIUS = /\brounded-(?:sm|md|lg|xl|2xl)\b/;

function isBoxyIconButton(classNames: string): boolean {
  return SQUARE.test(classNames) && HOVER_BG.test(classNames) && BOXY_RADIUS.test(classNames);
}

function classNameLiterals(source: string): string[] {
  return [...source.matchAll(/className=(?:"([^"]*)"|\{[^}]*?"([^"]*)"[^}]*?\})/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

describe("hover background of square icon buttons is fully round", () => {
  it("no button in apps/web/src combines fixed square size + hover background + rounded square", () => {
    const offenders = [...walk(SRC)].flatMap((file) => {
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.some((a) => rel.endsWith(a.split("/").pop() ?? ""))) return [];
      return classNameLiterals(readFileSync(file, "utf8"))
        .filter(isBoxyIconButton)
        .map((c) => `${rel} → ${c}`);
    });
    expect(offenders).toEqual([]);
  });

  it("a violation needs all three criteria, any one missing does not count", () => {
    expect(isBoxyIconButton("flex size-8 items-center rounded-lg hover:bg-muted")).toBe(true);
    expect(isBoxyIconButton("flex h-8 w-8 items-center rounded-md hover:bg-muted")).toBe(true);
    expect(isBoxyIconButton("flex size-8 items-center rounded-full hover:bg-muted")).toBe(false);
    expect(isBoxyIconButton("w-full rounded-md px-2.5 py-2 hover:bg-muted")).toBe(false);
    expect(isBoxyIconButton("size-8 rounded-lg bg-muted")).toBe(false);
  });
});
