import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../src");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// 只取设置页那一段:四页的预取同住一个文件(FOL-81 把四份 loader 身体搬了进去,
// 一份两用:路由 loader 与导航 pointerdown 预热共用),不切出来的话「设置页不 await」
// 会被隔壁那页的行冒充。找不到就抛 —— 切空了的话下面每条 `not.toMatch` 都是空断言。
function prefetchBody(name: string): string {
  const all = stripComments(src("lib/queries/prefetch-pages.ts"));
  const start = all.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`prefetch-pages.ts 里没有 ${name}`);
  const next = all.indexOf("export function", start + 1);
  return next < 0 ? all.slice(start) : all.slice(start, next);
}

describe("设置页 loader 不再等待慢查询", () => {
  it("发出三条设置查询,但不 await", () => {
    const route = prefetchBody("prefetchSettings");
    expect(route).toContain("providerKeyStatusQuery(");
    expect(route).toContain("valuationSettingsQuery(");
    expect(route).toContain("dataStatsQuery(");
    expect(route).not.toMatch(/await Promise\.all/);
    expect(route).not.toMatch(/await queryClient\.ensureQueryData/);
  });
});

describe("设置慢卡各自加载", () => {
  it("页壳不挂起那三条查询", () => {
    const page = stripComments(src("routes/_authed/-settings/index.tsx"));
    expect(page).not.toContain("useSuspenseQuery");
    expect(page).not.toContain("providerKeyStatusQuery");
    expect(page).not.toContain("valuationSettingsQuery");
    expect(page).not.toContain("dataStatsQuery");
  });

  it("Provider key 和估值失败一直再试,没数据走骨架", () => {
    const keys = stripComments(src("routes/_authed/-settings/provider-keys-card.tsx"));
    const val = stripComments(src("routes/_authed/-settings/valuation-card.tsx"));
    expect(keys).toContain("retry: true");
    expect(val).toContain("retry: true");
    expect(keys).toContain("status == null");
    expect(val).toContain("mode == null");
  });

  it("数据卡只有确认库是空的才跳过合并确认", () => {
    const data = stripComments(src("routes/_authed/-settings/data-card.tsx"));
    expect(data).toContain("statsQuery.data?.hasData === false");
  });
});
