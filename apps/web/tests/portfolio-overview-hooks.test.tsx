import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PinScopeKey } from "@/lib/queries/keys";
import { account, resetWorld, server, world } from "./helpers/fake-portfolio-server";

// 首页总览在浏览器里由原子查询合并(FOL-54 / FOL-56):
// · 归档账户不计;自定义 Tab(pin)按账户 / 场馆 / 标签收窄,总额只算收窄后的账户;
// · 刚加账户、首次同步还没落快照时是「加载中」而不是 $0,并且会短轮询直到快照到了;
// · tab 条用的原料不按 pin 收窄。
// 只替换 server fn 这层取数,其余(queryOptions、线上形状解析、合并计算)走真代码。

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
  it("不收窄:只算活跃账户,归档的不进总额", async () => {
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    const o = out.current as Overview;
    expect(ids(o)).toEqual(["a1", "a2"]);
    expect(o.totalUsd).toBe(150);
    expect(o.pending).toBe(false);
  });

  it("按账户收窄", async () => {
    const out = mountOverview({ kind: "account", accountId: "a2" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(ids(out.current as Overview)).toEqual(["a2"]);
    expect(out.current?.totalUsd).toBe(50);
  });

  it("按场馆收窄(同场馆的归档账户仍不计)", async () => {
    const out = mountOverview({ kind: "connector", connectorId: "okx" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(ids(out.current as Overview)).toEqual(["a2"]);
    expect(out.current?.totalUsd).toBe(50);
  });

  it("按标签收窄", async () => {
    const out = mountOverview({ kind: "tag", tagId: "t1" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(ids(out.current as Overview)).toEqual(["a1"]);
    expect(out.current?.totalUsd).toBe(100);
  });

  it("链平台元数据只为在用的链去问", async () => {
    const out = mountOverview({ kind: "account", accountId: "a1" });
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(server.resolvePlatformMeta).toHaveBeenCalledWith({ data: { chainIds: ["ethereum"] } });
  });

  it("刚加的账户还没有快照 → 加载中;短轮询拿到第一张快照后转为正常", async () => {
    world.accounts = { p1: [account({ id: "fresh", createdAt: Date.now() })] };
    world.snapshotsNow = [];
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(out.current?.pending).toBe(true);
    world.snapshotsNow = [snap("fresh", 7)];
    await waitFor(() => expect(out.current?.pending).toBe(false), { timeout: 3000 });
    expect(out.current?.totalUsd).toBe(7);
  });

  it("刚加的账户已经有快照 → 不轮询", async () => {
    world.accounts = { p1: [account({ id: "fresh", createdAt: Date.now() })] };
    world.snapshotsNow = [snap("fresh", 7)];
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    const nowCalls = () => server.getSnapshots.mock.calls.filter(([a]) => a.data.after == null);
    const before = nowCalls().length;
    // 首轮轮询间隔是 1s:等过它,当下快照不该被再取一次。
    await new Promise((r) => setTimeout(r, 1300));
    expect(nowCalls()).toHaveLength(before);
  });

  it("加了很久仍没有快照(同步不成)→ 不是加载中,显 0", async () => {
    world.accounts = { p1: [account({ id: "stuck", createdAt: Date.now() - 60 * 60_000 })] };
    world.snapshotsNow = [];
    const out = mountOverview();
    await waitFor(() => expect(out.current).not.toBeNull());
    expect(out.current?.pending).toBe(false);
    expect(out.current?.totalUsd).toBe(0);
  });
});

describe("usePortfolioSnapshotAtoms(tab 条原料)", () => {
  it("只收活跃账户,口径随原料带出", async () => {
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
