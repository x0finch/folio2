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
  // 缓存命中的后台刷新**不该再出骨架**。以前这条靠「看 isPending 不看 isFetching」保证;
  // 现在盈亏走挂起,而 `useSuspenseQuery` 命中缓存时直接给旧值、后台刷新、**不挂起** ——
  // 同一个性质由 react-query 自己保证。所以这条改成钉两件事:没人退回去看 isFetching,
  // 以及**兜底不是整块骨架**(hero 的兜底里总净值已经在了,列表的兜底里市值已经在了)。
  it("回访不闪骨架:盈亏随总览一起到,兜底是同一份内容而不是整块骨架", () => {
    const hero = stripComments(src("routes/_authed/-home/hero/index.tsx"));
    const holdings = stripComments(src("routes/_authed/-home/holdings/index.tsx"));
    expect(hero).not.toContain("isFetching");
    expect(holdings).not.toContain("isFetching");
    // FOL-51:盈亏改成随总览原料两端相减算好,不再是后到的一条 —— 没有独立的盈亏查询 / 边界。
    expect(hero).not.toContain("portfolioGain24hQuery");
    expect(holdings).not.toContain("portfolioGain24hQuery");
    // 盈亏直接从总览读(hero 与列表都是)。
    expect(hero).toMatch(/overview\.gain24h/);
    // hero 仅剩曲线是后到的一样:它的边界兜底仍是同一份内容(总净值 / 盈亏已经在了)。
    expect(hero).toMatch(/pending=\{<HeroShell overview=\{data\} loading/);
  });

  it("路由没有 pendingComponent,冷启动骨架是岛上那套,不是另一张整页骨架", () => {
    const home = stripComments(src("routes/_authed/index.tsx"));
    expect(home).not.toContain("pendingComponent");
  });

  // **别用「补水完成了没」这种开关去躲骨架。** 那样两边确实一致了,代价是服务端也只渲骨架 ——
  // SSR 出去的 HTML 里那些数字就没了,JS 跑起来之前谁都看不到。真要一致,该让两边挂在同一个
  // 挂起点上(现在的做法),不是把服务端那半也蒙掉。**试过一次,就是因为这条被挡回来的。**
  it("没有自造 hydration 开关来躲骨架", () => {
    for (const rel of [
      "routes/_authed/-home/index.tsx",
      "routes/_authed/-home/hero/index.tsx",
      "routes/_authed/-home/holdings/index.tsx",
    ]) {
      expect(src(rel)).not.toMatch(/useHydrated|use-hydrated|isHydrated/);
    }
  });

  // 这个断言跟着 ticker 走:#470 片7 把「大数字长什么样、怎么滚」收进了共用的 AmountTicker
  // (hero + 两个抽屉同一份),于是这条性质的产地也搬到那儿了。要保的东西没变。
  it("净值 ticker 数据一到就滚,不等进视口(避免 hydration 后再从 0 滚一遍)", () => {
    expect(src("components/amount-ticker.tsx")).toContain("startOnView={false}");
  });
});
