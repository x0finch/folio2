import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #488 票 6:四拍之间只该淡入,不该把后面的块顶来顶去。骨架跟真内容漂了,
// 没有运行时报错,只有「数字出来的时候整页顿一下」。

const ROOT = join(import.meta.dirname, "../src");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("骨架与真内容同形", () => {
  it("hero 骨架与 PortfolioHero 外框同高", () => {
    expect(src("routes/_authed/-home/hero/portfolio-hero.tsx")).toContain("min-h-60");
    expect(src("routes/_authed/-home/index.tsx")).toMatch(/function HeroSkeleton[\s\S]*min-h-60/);
  });

  it("持仓行骨架贴合真实行的 padding 与头像尺寸", () => {
    const skel = src("routes/_authed/-home/index.tsx");
    expect(src("routes/_authed/-home/holdings/tokens/index.tsx")).toContain("px-3 py-3");
    expect(skel).toContain("px-3 py-3");
    expect(skel).toContain("size-8");
  });

  it("tab 条骨架与真条同一套横向排布", () => {
    expect(src("routes/_authed/-home/tab/index.tsx")).toContain("flex items-center gap-4");
    expect(src("routes/_authed/-home/index.tsx")).toMatch(
      /function TabStripSkeleton[\s\S]*flex items-center gap-4/,
    );
  });

  it("tab 条合计位有下限宽度,等待走骨架而不是破折号", () => {
    const strip = src("routes/_authed/-home/tab/index.tsx");
    expect(strip).toContain("min-w-24");
    expect(strip).toContain("<TabTotalSkeleton");
    expect(strip).not.toContain('pending="—"');
    expect(strip).toMatch(/function TabTotalSkeleton[\s\S]*inline-block h-4 w-24/);
  });
});

describe("盈亏骨架三处复用同一元件", () => {
  it("行内 / hero 增量 / best-worst 都走 <GainSkeleton>", () => {
    expect(src("routes/_authed/-home/holdings/value-delta.tsx")).toContain("<GainSkeleton");
    const hero = src("routes/_authed/-home/hero/portfolio-hero.tsx");
    expect(hero.match(/<GainSkeleton/g)?.length).toBe(3);
  });

  it("宽度锁死在一处", () => {
    expect(src("routes/_authed/-home/holdings/value-delta.tsx")).toMatch(
      /function GainSkeleton[\s\S]*inline-block h-4 w-28/,
    );
  });
});

describe("回访不闪骨架、数字只滚一次", () => {
  it("盈亏加载态看 isPending,不看 isFetching —— 缓存命中后台刷新不该再出骨架", () => {
    const hero = stripComments(src("routes/_authed/-home/hero/index.tsx"));
    const holdings = stripComments(src("routes/_authed/-home/holdings/index.tsx"));
    expect(hero).toContain("gainQuery.isPending");
    expect(holdings).toContain("gainQuery.isPending");
    expect(hero).not.toContain("gainQuery.isFetching");
    expect(holdings).not.toContain("gainQuery.isFetching");
  });

  it("路由没有 pendingComponent,冷启动骨架是岛上那套,不是另一张整页骨架", () => {
    const home = stripComments(src("routes/_authed/index.tsx"));
    expect(home).not.toContain("pendingComponent");
  });

  it("没有自造 hydration 开关来躲骨架", () => {
    const page = src("routes/_authed/-home/index.tsx");
    expect(page).not.toMatch(/useHydrated|use-hydrated|isHydrated/);
  });

  it("净值 ticker 数据一到就滚,不等进视口(避免 hydration 后再从 0 滚一遍)", () => {
    expect(src("routes/_authed/-home/hero/portfolio-hero.tsx")).toContain("startOnView={false}");
  });
});
