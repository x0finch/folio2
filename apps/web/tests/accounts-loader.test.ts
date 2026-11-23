import { describe, expect, it } from "vitest";
import { prefetchBody } from "./helpers/prefetch-source";

// The accounts loader must fire the holdings query without awaiting it: awaiting brings back the
// blank screen on hard refresh, with no runtime error. The loader body lives in prefetchAccounts.
describe("accounts loader no longer waits on slow queries", () => {
  it("fires the atomic holdings resource without awaiting", () => {
    const src = prefetchBody("prefetchAccounts");
    expect(src).toContain("accountHoldingsSnapshotQueries(");
    expect(src).toContain("tokenEnrichmentQuery(");
    expect(src).not.toMatch(/await Promise\.all\([\s\S]*accountHoldingsSnapshotQueries/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(accountHoldingsSnapshotQueries/);
    expect(src).not.toContain("accountHoldingsQuery(");
    expect(src).not.toContain("listAccountHoldings");
  });

  it("fires tags without awaiting — tags don't block the list", () => {
    const src = prefetchBody("prefetchAccounts");
    expect(src).toContain("tagListQuery(");
    expect(src).toContain("accountTagLinksQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(tagListQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(accountTagLinksQuery/);
  });
});
