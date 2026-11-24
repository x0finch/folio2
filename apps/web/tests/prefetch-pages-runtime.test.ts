import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, resetWorld, server, world } from "./helpers/fake-portfolio-server";

// Runs each page's prefetch for real: it returns without awaiting, and its keys match the keys
// the page reads (a mismatch means the first paint fetches everything again).

vi.mock("@/lib/server/accounts", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.accounts),
);
vi.mock("@/lib/server/holdings", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.holdings),
);
vi.mock("@/lib/server/manual-tokens", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.manualTokens),
);
vi.mock("@/lib/server/portfolio", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.portfolio),
);
vi.mock("@/lib/server/portfolios", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.portfolios),
);
vi.mock("@/lib/server/tab-pins", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.tabPins),
);
vi.mock("@/lib/server/settings", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.settings),
);
vi.mock("@/lib/server/tags", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.tags),
);
vi.mock("@/lib/server/tokens", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.tokens),
);
vi.mock("@/lib/server/connectors", () =>
  import("./helpers/fake-portfolio-server").then((m) => m.modules.connectors),
);

const { prefetchAccounts, prefetchInsights, prefetchOverview, prefetchSettings } = await import(
  "@/lib/queries/prefetch-pages"
);
const { fetchPortfolioSnapshotAtoms } = await import("@/lib/queries/portfolio-overview-compose");

const T0 = Date.UTC(2026, 9, 4, 10, 25);

let qc: QueryClient;

// Let issued requests settle (fake timers only fake Date; microtasks run normally).
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetWorld();
  qc = new QueryClient();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

// No `qc.clear()`: it would cancel in-flight fire-and-forget prefetches into unhandled rejections.
afterEach(() => {
  vi.useRealTimers();
});

describe("Returns immediately", () => {
  it("prefetch has returned (not a Promise) while requests are still in flight", () => {
    server.getSnapshots.mockImplementation(() => new Promise(() => {}));
    expect(prefetchOverview(qc, "p1")).toBeUndefined();
    expect(prefetchInsights(qc, "p1")).toBeUndefined();
    expect(prefetchAccounts(qc, "p1")).toBeUndefined();
    expect(prefetchSettings(qc)).toBeUndefined();
    expect(server.getSnapshots).toHaveBeenCalled();
  });
});

describe("Prefetch keys match the keys pages read", () => {
  it("after the overview prefetch, assembling snapshot inputs within the hour does not refetch", async () => {
    world.accounts = { p1: [account({ id: "a1" })] };
    prefetchOverview(qc, "p1");
    await settle();
    const calls = () =>
      [
        server.listAccounts,
        server.getSnapshots,
        server.getValuationSettings,
        server.getTokenEnrichment,
        server.listConnectors,
        server.getFiatRefs,
      ].map((f) => f.mock.calls.length);
    const before = calls();
    vi.setSystemTime(T0 + 5 * 60_000);
    await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(calls()).toEqual(before);
  });
});
