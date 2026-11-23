import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, resetWorld, server, tag, world } from "./helpers/fake-portfolio-server";

// Account/portfolio read entry points (queryOptions) and non-hook snapshot-input assembly.
// Only the server-fn fetch layer is replaced; everything else runs for real.

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

const { accountHistoryQuery, accountListQuery, holdingHistoryQuery, manualAccountQuery } =
  await import("@/lib/queries/accounts");
const { fetchHomeTabStrip, portfolioHistoryQuery, portfolioListQuery, portfolioTabPinsQuery } =
  await import("@/lib/queries/portfolio");
const { fetchPortfolioSnapshotAtoms } = await import("@/lib/queries/portfolio-overview-compose");
const { tagListQuery } = await import("@/lib/queries/tags");

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 4, 10, 5); // 10:05; the hour anchor is 10:00

let qc: QueryClient;

beforeEach(() => {
  resetWorld();
  qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  qc.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("accountListQuery", () => {
  it("fetches one per portfolio, decodes JSON rows", async () => {
    world.accounts = { p1: [account({ id: "a1" })], p2: [account({ id: "b1" })] };
    const p1 = await qc.fetchQuery(accountListQuery("p1"));
    const p2 = await qc.fetchQuery(accountListQuery("p2"));
    expect(p1.map((a) => a.id)).toEqual(["a1"]);
    expect(p2.map((a) => a.id)).toEqual(["b1"]);
    expect(server.listAccounts).toHaveBeenCalledWith({ data: { portfolioId: "p1" } });
  });

  it("in the browser failures keep retrying past the default 5 until success", async () => {
    vi.stubGlobal("window", {});
    let calls = 0;
    server.listAccounts.mockImplementation(async () => {
      calls++;
      if (calls <= 7) throw new Error("Invariant failed");
      return new Response(JSON.stringify([account({ id: "a1" })]));
    });
    const rows = await qc.fetchQuery(accountListQuery("p1"));
    expect(rows.map((a) => a.id)).toEqual(["a1"]);
    expect(calls).toBe(8);
  });
});

describe("accountHistoryQuery / holdingHistoryQuery", () => {
  it("window tier is in the key, the computed start is not: a new start with the same tier hits the same cache", async () => {
    const base = { accountId: "a1", range: "30d" as const, connectorId: "binance" as const };
    await qc.fetchQuery(accountHistoryQuery({ ...base, since: 1000 }));
    await qc.fetchQuery(accountHistoryQuery({ ...base, since: 2000 }));
    expect(server.getAccountHistory).toHaveBeenCalledTimes(1);
    await qc.fetchQuery(accountHistoryQuery({ ...base, range: "all", since: undefined }));
    expect(server.getAccountHistory).toHaveBeenCalledTimes(2);
  });

  it("request carries start, window and connectorId (the server routes on them)", async () => {
    const out = await qc.fetchQuery(
      accountHistoryQuery({ accountId: "a1", range: "7d", since: 42, connectorId: "manual" }),
    );
    expect(server.getAccountHistory).toHaveBeenCalledWith({
      data: { accountId: "a1", since: 42, connectorId: "manual", range: "7d" },
    });
    expect(out).toEqual({ points: [] });
  });

  it("single-holding history: requested by holdingKey, keyed by window only", async () => {
    await qc.fetchQuery(holdingHistoryQuery({ holdingKey: "tok:eth", range: "1y", since: 5 }));
    await qc.fetchQuery(holdingHistoryQuery({ holdingKey: "tok:eth", range: "1y", since: 9 }));
    expect(server.getTokenValueHistory).toHaveBeenCalledTimes(1);
    expect(server.getTokenValueHistory).toHaveBeenCalledWith({
      data: { key: "tok:eth", since: 5, range: "1y" },
    });
  });

  it("manual account details requested by accountId", async () => {
    await qc.fetchQuery(manualAccountQuery("m1"));
    expect(server.getManualAccount).toHaveBeenCalledWith({ data: { accountId: "m1" } });
  });
});

describe("Portfolio reads", () => {
  it("the portfolio list also retries forever in the browser", async () => {
    vi.stubGlobal("window", {});
    let calls = 0;
    server.listPortfolios.mockImplementation(async () => {
      calls++;
      if (calls <= 6) throw new Error("boom");
      return { portfolios: [], defaultId: null };
    });
    await qc.fetchQuery(portfolioListQuery());
    expect(calls).toBe(7);
  });

  it("trend defaults to a 30-day window", async () => {
    await qc.fetchQuery(portfolioHistoryQuery("p1"));
    expect(server.getPortfolioHistory).toHaveBeenCalledWith({
      data: { portfolioId: "p1", range: "30d" },
    });
    expect(qc.getQueryData(portfolioHistoryQuery("p1", "30d").queryKey)).toEqual({ points: [] });
  });

  it("tab strip pin inputs requested per portfolio", async () => {
    await qc.fetchQuery(portfolioTabPinsQuery("p1"));
    expect(server.getPortfolioTabPins).toHaveBeenCalledWith({ data: { portfolioId: "p1" } });
  });
});

describe("fetchHomeTabStrip — refreshing the tab strip after a pin write", () => {
  it("pins and tags refetch past the cache: a new tag pin shows the latest tag name", async () => {
    world.accounts = { p1: [account({ id: "a1" })] };
    world.accountTags = [{ accountId: "a1", tagId: "t1" }];
    // Cache holds the pre-write state: no pin yet, tag has the old name (still within staleTime).
    qc.setQueryData(portfolioTabPinsQuery("p1").queryKey, { pins: [], connectorMeta: [] });
    qc.setQueryData(tagListQuery("p1").queryKey, [tag("t1", "Old")]);
    // The server already has the post-write state.
    world.tabPins = {
      pins: [{ id: "pin-1", kind: "tag", tagId: "t1", connectorId: null, accountId: null }],
      connectorMeta: [],
    };
    world.tags = [tag("t1", "Long-term")];

    const strip = await fetchHomeTabStrip(qc, "p1");
    expect(strip.hasAccounts).toBe(true);
    expect(strip.pins).toEqual([
      expect.objectContaining({ id: "pin-1", kind: "tag", tagId: "t1", name: "Long-term" }),
    ]);
  });

  it("pins pointing at accounts no longer in this portfolio are dropped; only archived accounts -> no accounts", async () => {
    world.accounts = { p1: [account({ id: "a1", archivedAt: 1 })] };
    world.tabPins = {
      pins: [{ id: "pin-a", kind: "account", accountId: "a1", tagId: null, connectorId: null }],
      connectorMeta: [],
    };
    const strip = await fetchHomeTabStrip(qc, "p1");
    expect(strip.hasAccounts).toBe(false);
    expect(strip.pins).toEqual([]);
  });
});

describe("fetchPortfolioSnapshotAtoms — snapshot inputs via the non-hook path", () => {
  beforeEach(() => {
    world.accounts = {
      p1: [
        account({ id: "a1", connectorId: "binance" }),
        account({ id: "a2", connectorId: "evm" }),
        account({ id: "old", connectorId: "okx", archivedAt: 1 }),
      ],
    };
    world.catalog = {
      binance: { label: "Binance", logo: "/b.png" },
      okx: { label: "OKX" },
      kraken: { label: "Kraken" },
    };
    world.snapshotsNow = [
      {
        accountId: "a1",
        takenAt: T0 - 60_000,
        totalUsd: 100,
        balances: [{ id: "b1", amount: 1, usdValue: 100, tokenId: "usdt" }],
      },
      {
        accountId: "a2",
        takenAt: T0 - 60_000,
        totalUsd: 50,
        balances: [{ id: "b2", amount: 2, usdValue: 50, tokenId: "eth", platform: "arbitrum" }],
      },
    ];
    world.valuationMode = "source-first";
    world.fiatRefs = [["usd-token", "fiat/issued:USD"]];
    world.platformMeta = [["arbitrum", { name: "Arbitrum" }]];
    world.enriched = [
      ["eth", { id: "eth", symbol: "ETH", name: "Ether", price: 25, hasLogo: true, hasRef: true }],
    ];
  });

  it("only active accounts; basis / fiat refs / platform meta carried along", async () => {
    const raw = await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(raw.accounts.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(raw.snapshots.map(([id]) => id)).toEqual(["a1", "a2"]);
    expect(raw.mode).toBe("source-first");
    expect(raw.fiatRefs).toEqual([["usd-token", "fiat/issued:USD"]]);
    expect(raw.platformMeta).toEqual([["arbitrum", { name: "Arbitrum" }]]);
    expect(raw.now).toBe(Math.floor(T0 / HOUR) * HOUR);
  });

  it("venue display names only for venues in use; chain keys are left to platformMeta", async () => {
    const raw = await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(raw.connectorMeta).toEqual([["binance", { name: "Binance", logo: "/b.png" }]]);
    expect(server.resolvePlatformMeta).toHaveBeenCalledWith({ data: { chainIds: ["arbitrum"] } });
  });

  it("enrichment map slimmed to the fields the view needs", async () => {
    const raw = await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(raw.enriched).toEqual([
      ["eth", { id: "eth", symbol: "ETH", name: "Ether", price: 25, hasLogo: true }],
    ]);
  });

  it("snapshot key uses the hour anchor: reuse cache within the hour, refetch after it", async () => {
    await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(server.getSnapshots).toHaveBeenCalledTimes(2); // now + 24h ago
    vi.setSystemTime(T0 + 10 * 60_000); // 10:15
    await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(server.getSnapshots).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + 60 * 60_000); // 11:05
    await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(server.getSnapshots).toHaveBeenCalledTimes(4);
  });
});
