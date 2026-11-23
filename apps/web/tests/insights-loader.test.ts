import { describe, expect, it } from "vitest";
import { prefetchBody, readSrc, stripComments } from "./helpers/prefetch-source";

//

describe("insights loader no longer waits for slow queries", () => {
  it("fires the atomic snapshot and history without awaiting", () => {
    const route = prefetchBody("prefetchInsights");
    expect(route).toContain("accountHoldingsSnapshotQueries(");
    expect(route).toContain("portfolioHistoryQuery(");
    expect(route).not.toMatch(/await Promise\.all\([\s\S]*accountHoldingsSnapshotQueries/);
    expect(route).not.toMatch(/await queryClient\.ensureQueryData\(portfolioHistoryQuery/);
    expect(route).not.toContain("portfolioOverviewQuery");
    expect(route).not.toContain("getPortfolioSnapshotData");
  });
});

describe("the two insights charts load independently", () => {
  //
  it("trend and distribution each have a boundary; no data (including failure) shows a skeleton", () => {
    const page = stripComments(readSrc("routes/_authed/-insights/index.tsx"));
    expect(page.match(/<QueryBoundary/g)).toHaveLength(2);
    expect(page.match(/pending=\{<Skeleton className=\{CHART_FRAME\} \/>\}/g)).toHaveLength(2);
    expect(page.match(/failed=\{<Skeleton className=\{CHART_FRAME\} \/>\}/g)).toHaveLength(2);
    expect(page).toContain("retry: true");
  });

  it("chart frame skeleton has the same height as the real chart", () => {
    expect(readSrc("routes/_authed/-insights/portfolio-chart.tsx")).toContain("CHART_FRAME");
    expect(readSrc("routes/_authed/-insights/index.tsx")).toContain("CHART_FRAME");
  });

  it("dimension tabs sit outside the pie boundary, clickable even without data", () => {
    const page = stripComments(readSrc("routes/_authed/-insights/index.tsx"));
    expect(page).toMatch(/<Tabs[\s\S]*\{pie\}/);
    expect(page).toMatch(/pie = \([\s\S]*<AllocationReady/);
  });

  it("both charts read holdings and the curve's last point from the atomic overview, merged", () => {
    const page = stripComments(readSrc("routes/_authed/-insights/index.tsx"));
    expect(page).toMatch(/usePortfolioOverview\(/);
    expect(page).not.toContain("portfolioOverviewQuery");
    expect(page).not.toContain("getPortfolioSnapshotData");
  });
});
