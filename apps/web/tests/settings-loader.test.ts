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

describe("设置页 loader 不再等待慢查询", () => {
  it("发出三条设置查询,但不 await", () => {
    const route = stripComments(src("routes/_authed/settings.tsx"));
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
