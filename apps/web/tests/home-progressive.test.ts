import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Between the four beats content should only fade in, never push blocks around. Skeleton/content drift
// raises no error, only a jolt when numbers land.

const ROOT = join(import.meta.dirname, "../src");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("skeleton matches real content", () => {
  it("hero skeleton is as tall as the PortfolioHero frame", () => {
    expect(src("routes/_authed/-home/hero/portfolio-hero.tsx")).toContain("min-h-60");
    expect(src("routes/_authed/-home/index.tsx")).toMatch(/function HeroSkeleton[\s\S]*min-h-60/);
  });

  it("holdings row skeleton matches the real row's padding and avatar size", () => {
    const skel = src("routes/_authed/-home/index.tsx");
    expect(src("routes/_authed/-home/holdings/tokens/index.tsx")).toContain("px-3 py-3");
    expect(skel).toContain("px-3 py-3");
    expect(skel).toContain("size-8");
  });

  it("tab strip skeleton uses the same horizontal layout as the real strip", () => {
    expect(src("routes/_authed/-home/tab/index.tsx")).toContain("flex items-center gap-4");
    expect(src("routes/_authed/-home/index.tsx")).toMatch(
      /function TabStripSkeleton[\s\S]*flex items-center gap-4/,
    );
  });

  it("tab strip total slot has a min width; waiting shows a skeleton, not a dash", () => {
    const strip = src("routes/_authed/-home/tab/index.tsx");
    expect(strip).toContain("min-w-24");
    expect(strip).toContain("<TabTotalSkeleton");
    expect(strip).not.toContain('pending="—"');
    expect(strip).toMatch(/function TabTotalSkeleton[\s\S]*inline-block h-4 w-24/);
  });
});

describe("no skeleton flash on revisit; numbers roll once", () => {
  // A cache-hit background refetch must not show a skeleton: useSuspenseQuery serves stale data without
  // suspending. So pin that nobody falls back to isFetching and that fallbacks aren't block skeletons.
  it("no skeleton flash on revisit: P&L arrives with the overview; the fallback is the same content", () => {
    const hero = stripComments(src("routes/_authed/-home/hero/index.tsx"));
    const holdings = stripComments(src("routes/_authed/-home/holdings/index.tsx"));
    expect(hero).not.toContain("isFetching");
    expect(holdings).not.toContain("isFetching");
    // P&L is computed with the overview's raw data; there's no separate P&L query / boundary.
    expect(hero).not.toContain("portfolioGain24hQuery");
    expect(holdings).not.toContain("portfolioGain24hQuery");
    // P&L is read straight from the overview (hero and list both).
    expect(hero).toMatch(/overview\.gain24h/);
    // Only the hero's curve arrives late; its fallback is the same content (net worth / P&L already there).
    expect(hero).toMatch(/pending=\{<HeroShell overview=\{data\} loading/);
  });

  it("route has no pendingComponent; the cold-start skeleton is the islands', not a second full-page one", () => {
    // All four pages share one `{-$page}` route; the single full-page skeleton lives at `_authed`.
    const home = stripComments(src("routes/_authed/{-$page}.tsx"));
    expect(home).not.toContain("pendingComponent");
  });

  // Don't dodge the skeleton with a "hydrated yet?" flag: the server would then render only skeletons and
  // the SSR HTML would lose its numbers. Both sides must suspend at the same point.
  it("no home-made hydration flag to dodge the skeleton", () => {
    for (const rel of [
      "routes/_authed/-home/index.tsx",
      "routes/_authed/-home/hero/index.tsx",
      "routes/_authed/-home/holdings/index.tsx",
    ]) {
      expect(src(rel)).not.toMatch(/useHydrated|use-hydrated|isHydrated/);
    }
  });

  // This lives in the shared AmountTicker (hero and both sheets).
  it("net worth ticker rolls as soon as data arrives, without waiting for the viewport (no second roll from 0 after hydration)", () => {
    expect(src("components/amount-ticker.tsx")).toContain("startOnView={false}");
  });
});
