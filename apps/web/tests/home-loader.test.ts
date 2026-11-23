import { describe, expect, it } from "vitest";
import { prefetchBody, readSrc, stripComments } from "./helpers/prefetch-source";

// The braces in the file name are real (optional path param `{-$page}`), not a template placeholder.
const ROUTE = "routes/_authed/{-$page}.tsx";

// The home loader awaits only the default portfolio id (prefetch keys must match); everything else is fired
// and not awaited. What to fetch lives in prefetchOverview; what to await stays in the merged route's loader.

describe("home loader no longer waits on slow queries", () => {
  it("fires the atomic snapshot and trend without awaiting them", () => {
    const src = prefetchBody("prefetchOverview");
    expect(src).toContain("accountHoldingsSnapshotQueries(");
    expect(src).toContain("portfolioHistoryQuery(");
    expect(src).not.toMatch(/await Promise\.all\([\s\S]*accountHoldingsSnapshotQueries/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioHistoryQuery/);
    expect(src).not.toContain("portfolioOverviewQuery");
    expect(src).not.toContain("getPortfolioSnapshotData");
  });

  it("fires tabPins and tags without awaiting", () => {
    const src = prefetchBody("prefetchOverview");
    expect(src).toContain("portfolioTabPinsQuery(");
    expect(src).toContain("tagListQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioTabPinsQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(tagListQuery/);
  });

  it("home reads 24h P&L from the overview (computed by endpoint subtraction with the raw data)", () => {
    const hero = stripComments(readSrc("routes/_authed/-home/hero/index.tsx"));
    expect(hero).toMatch(/overview\.gain24h/);
    expect(hero).toMatch(/usePortfolioOverview\(/);
    expect(hero).not.toContain("portfolioGain24hQuery");
    expect(hero).not.toContain("portfolioOverviewQuery");
    expect(hero).not.toContain("getPortfolioSnapshotData");
  });

  it("connector catalog and account list go into the loader (atomic resources); tags and tabPins fired, not awaited", () => {
    const src = prefetchBody("prefetchOverview");
    expect(src).toContain("connectorCatalogQuery");
    expect(src).toContain("accountListQuery");
    expect(src).toContain("tagListQuery");
    expect(src).toContain("portfolioTabPinsQuery");
    expect(src).not.toContain("portfolioOverviewQuery");
  });
});

describe("merged route waits only for which portfolio", () => {
  // Awaiting a page's prefetch brings back the blank screen on hard refresh, with no runtime error.
  // The loader may await only the portfolio and the shell's sync-summary inputs: the shell reads those via
  // useSuspenseQueries with no boundary of its own, so not waiting would collapse it into the skeleton on a
  // switch to an unseen portfolio. Cold load isn't slower — `_authed` awaits the same keys (deduped).
  it("loader awaits only two things: portfolioListQuery and the shell's sync-summary inputs", () => {
    const route = stripComments(readSrc(ROUTE));
    const awaits = route.match(/await [^\n]*/g) ?? [];
    expect(awaits).toHaveLength(2);
    expect(awaits[0]).toContain("portfolioListQuery()");
    expect(awaits[1]).toContain("prefetchSyncStatusAtoms(queryClient, selectedId)");
  });
});
