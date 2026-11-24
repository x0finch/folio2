import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PinScopeKey } from "@/lib/queries/keys";
import { account, resetWorld, server, world } from "./helpers/fake-portfolio-server";

// Home overview merges atomic queries in the browser. Only the server-fn fetch layer is replaced;
// queryOptions, wire parsing and merge math run for real.

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

const { usePortfolioOverview, usePortfolioSnapshotAtoms } = await import(
  "@/lib/queries/portfolio-overview-compose"
);

type Overview = ReturnType<typeof usePortfolioOverview>;
type Atoms = ReturnType<typeof usePortfolioSnapshotAtoms>;

function mountOverview(pin?: PinScopeKey) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = { current: null as Overview | null };
  function Probe() {
    out.current = usePortfolioOverview("p1", pin);
    return null;
  }
  render(
    <QueryClientProvider client={qc}>
      <Suspense fallback={null}>
        <Probe />
      </Suspense>
    </QueryClientProvider>,
  );
  return out;
}

const snap = (accountId: string, usd: number) => ({
  accountId,
  takenAt: Date.now() - 60_000,
  totalUsd: usd,
  balances: [{ id: `${accountId}-usdt`, amount: usd, usdValue: usd, platform: "ethereum" }],
});

const ids = (o: Overview) => o.accountTotals.map((t) => t.account.id).sort();

beforeEach(() => {
  resetWorld();
  world.accounts = {
    p1: [
      account({ id: "a1", connectorId: "binance" }),
      account({ id: "a2", connectorId: "okx" }),
      account({ id: "gone", connectorId: "okx", archivedAt: 1 }),
    ],
  };
  world.accountTags = [{ accountId: "a1", tagId: "t1" }];
  world.catalog = { binance: { label: "Binance" }, okx: { label: "OKX" } };
  world.snapshotsNow = [snap("a1", 100), snap("a2", 50), snap("gone", 1000)];
});

describe("usePortfolioOverview", () => {
  it("no narrowing: only active accounts count, archived are excluded", async () => {
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    const o = out.current as Overview;
    expect(ids(o)).toEqual(["a1", "a2"]);
    expect(o.totalUsd).toBe(150);
    expect(o.pending).toBe(false);
  });

  it("narrow by account", async () => {
    const out = mountOverview({ kind: "account", accountId: "a2" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(ids(out.current as Overview)).toEqual(["a2"]);
    expect(out.current?.totalUsd).toBe(50);
  });

  it("narrow by venue (archived accounts on the same venue still excluded)", async () => {
    const out = mountOverview({ kind: "connector", connectorId: "okx" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(ids(out.current as Overview)).toEqual(["a2"]);
    expect(out.current?.totalUsd).toBe(50);
  });

  it("narrow by tag", async () => {
    const out = mountOverview({ kind: "tag", tagId: "t1" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(ids(out.current as Overview)).toEqual(["a1"]);
    expect(out.current?.totalUsd).toBe(100);
  });

  it("chain platform metadata is requested only for chains in use", async () => {
    const out = mountOverview({ kind: "account", accountId: "a1" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(server.resolvePlatformMeta).toHaveBeenCalledWith({ data: { chainIds: ["ethereum"] } });
  });

  it("new account without a snapshot -> loading; short polling turns normal once the first snapshot lands", async () => {
    world.accounts = { p1: [account({ id: "fresh", createdAt: Date.now() })] };
    world.snapshotsNow = [];
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(out.current?.pending).toBe(true);
    world.snapshotsNow = [snap("fresh", 7)];
    await waitFor(() => expect(out.current?.pending).toBe(false), { timeout: 3000 });
    expect(out.current?.totalUsd).toBe(7);
  });

  it("new account that already has a snapshot -> no polling", async () => {
    world.accounts = { p1: [account({ id: "fresh", createdAt: Date.now() })] };
    world.snapshotsNow = [snap("fresh", 7)];
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    const nowCalls = () => server.getSnapshots.mock.calls.filter(([a]) => a.data.after == null);
    const before = nowCalls().length;
    // The first poll interval is 1s; after waiting past it the current snapshot is not refetched.
    await new Promise((r) => setTimeout(r, 1300));
    expect(nowCalls()).toHaveLength(before);
  });

  it("no snapshot long after creation (sync failing) -> not loading, shows 0", async () => {
    world.accounts = { p1: [account({ id: "stuck", createdAt: Date.now() - 60 * 60_000 })] };
    world.snapshotsNow = [];
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(out.current?.pending).toBe(false);
    expect(out.current?.totalUsd).toBe(0);
  });
});

describe("usePortfolioSnapshotAtoms (tab strip inputs)", () => {
  it("only active accounts; basis carried along with the inputs", async () => {
    world.valuationMode = "source-first";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const out = { current: null as Atoms | null };
    function Probe() {
      out.current = usePortfolioSnapshotAtoms("p1");
      return null;
    }
    render(
      <QueryClientProvider client={qc}>
        <Suspense fallback={null}>
          <Probe />
        </Suspense>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(out.current).not.toBeNull());
    const raw = out.current as Atoms;
    expect(raw.accounts.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(raw.mode).toBe("source-first");
    expect(raw.connectorMeta.map(([k]) => k).sort()).toEqual(["binance", "okx"]);
  });
});
