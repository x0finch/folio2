import { describe, expect, it } from "vitest";
import { prefetchBody, readSrc, stripComments } from "./helpers/prefetch-source";

describe("settings page loader no longer waits for slow queries", () => {
  it("fires the three settings queries without awaiting them", () => {
    const route = prefetchBody("prefetchSettings");
    expect(route).toContain("providerKeyStatusQuery(");
    expect(route).toContain("valuationSettingsQuery(");
    expect(route).toContain("dataStatsQuery(");
    expect(route).not.toMatch(/await Promise\.all/);
    expect(route).not.toMatch(/await queryClient\.ensureQueryData/);
  });
});

describe("settings slow cards load independently", () => {
  it("page shell does not suspend on the three queries", () => {
    const page = stripComments(readSrc("routes/_authed/-settings/index.tsx"));
    expect(page).not.toContain("useSuspenseQuery");
    expect(page).not.toContain("providerKeyStatusQuery");
    expect(page).not.toContain("valuationSettingsQuery");
    expect(page).not.toContain("dataStatsQuery");
  });

  it("provider key and valuation keep retrying on failure; no data shows a skeleton", () => {
    const keys = stripComments(readSrc("routes/_authed/-settings/provider-keys-card.tsx"));
    const val = stripComments(readSrc("routes/_authed/-settings/valuation-card.tsx"));
    expect(keys).toContain("retry: true");
    expect(val).toContain("retry: true");
    expect(keys).toContain("status == null");
    expect(val).toContain("mode == null");
  });

  it("data card skips the merge confirmation only when the library is confirmed empty", () => {
    const data = stripComments(readSrc("routes/_authed/-settings/data-card.tsx"));
    expect(data).toContain("statsQuery.data?.hasData === false");
  });
});
