import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// List first, values later. Drift between skeleton and real content raises no error, only a layout jump
// when numbers land or a skeleton flash on revisit.

const ROOT = join(import.meta.dirname, "../src");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("skeleton matches real content", () => {
  it("list skeleton matches the real row padding", () => {
    const page = src("routes/_authed/-accounts/index.tsx");
    expect(page).toMatch(/function ListSkeleton[\s\S]*px-4 py-6/);
    expect(page).toMatch(/function AccountRowContent[\s\S]*px-4 py-6/);
  });

  it("values not loaded → skeleton, not 0 and not a dash", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toContain("!row.valuesReady");
    expect(page).not.toMatch(/valuesReady[\s\S]{0,80}usd\(0\)/);
  });
});

describe("no skeleton flash on revisit; value failure keeps the skeleton", () => {
  // Late data suspends behind QueryBoundary rather than useQuery + isPending: with SSR the server often has
  // the data while the hydrating client doesn't, and mismatched HTML makes React discard the subtree.
  it("no skeleton flash on revisit: late data suspends, nothing falls back to isFetching", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    // useSuspenseQuery serves cached data without suspending; isFetching would draw background refetches as skeletons.
    expect(page).not.toContain("isFetching");
    // Late data is holdings (24h P&L included) and tags; there is no separate P&L query.
    expect(page).toMatch(/useAccountHoldingsView\(/);
    expect(page).not.toContain("accountHoldingsQuery");
    expect(page).not.toContain("listAccountHoldings");
    expect(page).not.toContain("accountGain24hQuery");
  });

  // The list is fetched per portfolio on the server, so the client never holds other portfolios' accounts.
  it("list fetched for the current portfolio and suspends at the outer boundary (no draw-then-fix)", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toMatch(/useSuspenseQuery\(accountListQuery\(selectedId\)\)/);
    // No client-side "fetch all + filter by membership" path.
    expect(page).not.toContain("portfolioMembershipsQuery");
    expect(page).not.toContain("accountIdsInView");
  });

  // Tags must not block the list: they suspend at the inner boundary, whose pending fallback is the same body.
  it("tags don't block the list: inner suspense point, fallback is still the list", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    // The list itself suspends at the outer boundary; non-suspending would draw an incomplete list first.
    expect(page).toMatch(/useSuspenseQuery\(accountListQuery/);
    // Tags are fetched behind the inner boundary.
    expect(page).toMatch(/AccountsListReady[\s\S]*useSuspenseQuery\(tagListQuery/);
    // The inner fallback is the same list, not a block skeleton.
    expect(page).toMatch(/pending=\{[\s\S]{0,200}<AccountsListBody/);
    expect(page).toMatch(/allTags = \[\]/);
  });

  // Value failures must not replace a good list with "failed to load": the inner boundary's failed is the
  // same body (with gainFailed), not ListFailed.
  it("value failure doesn't show failed-to-load; list stays", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toMatch(/failed=\{[\s\S]{0,200}<AccountsListBody/);
    expect(page).not.toMatch(/failed=\{<ListFailed[\s\S]{0,200}<AccountsListReady/);
    // The outer boundary (the list itself failed) still uses ListFailed.
    expect(page).toMatch(/failed=\{<ListFailed \/>\}/);
  });

  it("delta read straight from the row's gain24h (arrives with holdings)", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    // P&L lives on AccountRow.gain24h; the row reads it directly.
    expect(page).not.toContain("gainPending");
    expect(page).not.toContain("gainFailed");
    expect(page).toMatch(/dayChange\?\.amount/);
  });

  // Don't dodge the skeleton with a "hydrated yet?" flag: the server would then render only skeletons and
  // the SSR HTML would lose its numbers. Both sides must suspend at the same point.
  it("no home-made hydration flag to dodge the skeleton", () => {
    const page = src("routes/_authed/-accounts/index.tsx");
    expect(page).not.toMatch(/useHydrated|use-hydrated|isHydrated/);
  });
});
