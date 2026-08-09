import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #146 的硬验收:方形纯图标按钮的 hover 底一律全圆。
//
// 为什么要机械可查:这类按钮到处都是,而「圆角方块 vs 圆」在截图上差别很小,review 时最容易滑过去。
// 而且它有个天然的复发源 —— beUI 的 `Button` 里 `size="icon"` 就是 `rounded-lg`(上游如此,不是
// 我们改坏的),照着别处抄一段 className 就又方回去了。所以拦在测试里,而不是靠记性。
//
// **判据只认「同时满足三条」的 className**:固定方形尺寸 + hover 背景 + 非全圆的圆角。
// 三条缺一不算 —— 带文字的按钮没有固定方形尺寸,菜单项/列表行没有 `size-*`,都不会被误伤。
// 真要写这么一颗,就用 `components/icon-button.tsx` 的 `IconButton`。
const SRC = join(import.meta.dirname, "../src");

// 允许 IconButton 自己出现在结果里 —— 它就是那个唯一的出口。
const ALLOWED = ["components/icon-button.tsx"];

const SQUARE = /\bsize-[6-9]\b|\bh-([6-9])\s+w-\1\b/;
const HOVER_BG = /hover:bg-/;
const BOXY_RADIUS = /\brounded-(?:sm|md|lg|xl|2xl)\b/;

/** 一行 className 字面量里同时出现三样 → 就是一颗方角的图标按钮。 */
function isBoxyIconButton(classNames: string): boolean {
  return SQUARE.test(classNames) && HOVER_BG.test(classNames) && BOXY_RADIUS.test(classNames);
}

// 只看 className 字符串本身,不看整份文件 —— 否则同一个组件里别处的 `rounded-lg`
// 会和另一处的 `size-8` 凑成假阳性。
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

describe("方形图标按钮的 hover 底是全圆", () => {
  it("apps/web/src 里没有「固定方尺寸 + hover 底 + 圆角方块」的按钮", () => {
    const offenders = [...walk(SRC)].flatMap((file) => {
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.some((a) => rel.endsWith(a.split("/").pop() ?? ""))) return [];
      return classNameLiterals(readFileSync(file, "utf8"))
        .filter(isBoxyIconButton)
        .map((c) => `${rel} → ${c}`);
    });
    expect(offenders).toEqual([]);
  });

  // 守卫本身的守卫:上面那条只有在真抓得到时才有意义。三条判据里任何一条写错,
  // 它都会变成一条永远绿的摆设,而且没人看得出来。
  it("三条判据齐了才算违规,缺一条都不算", () => {
    expect(isBoxyIconButton("flex size-8 items-center rounded-lg hover:bg-muted")).toBe(true);
    expect(isBoxyIconButton("flex h-8 w-8 items-center rounded-md hover:bg-muted")).toBe(true);
    // 已经是圆的 → 放行
    expect(isBoxyIconButton("flex size-8 items-center rounded-full hover:bg-muted")).toBe(false);
    // 菜单项:有 hover 底、有圆角,但不是固定方尺寸 → 放行
    expect(isBoxyIconButton("w-full rounded-md px-2.5 py-2 hover:bg-muted")).toBe(false);
    // 纯展示的方块:有尺寸有圆角,但没有 hover 底 → 放行
    expect(isBoxyIconButton("size-8 rounded-lg bg-muted")).toBe(false);
  });
});
