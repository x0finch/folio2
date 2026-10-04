import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, resetWorld, server, tag, world } from "./helpers/fake-portfolio-server";

// 账户域 / 组合域的读取入口(queryOptions)+ 非 hook 的快照原料组装:
// · 请求按组合分份、历史窗口进 key 而起点不进 key(否则每帧一条新缓存);
// · 外壳赖以存在的两条读(账户清单、组合清单)在浏览器里永不放弃重试(FOL-58 回归);
// · pin 写后刷 tab 条时 pins / 标签必须真重拉,不能吃缓存里的旧值;
// · 快照原料只算活跃账户、key 用整点锚(同一小时内复用缓存)。
// 只替换 server fn 这层取数,其余走真代码。

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
const T0 = Date.UTC(2026, 9, 4, 10, 5); // 10:05 —— 整点锚是 10:00

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
  it("按组合各取一份,解回 JSON 行", async () => {
    world.accounts = { p1: [account({ id: "a1" })], p2: [account({ id: "b1" })] };
    const p1 = await qc.fetchQuery(accountListQuery("p1"));
    const p2 = await qc.fetchQuery(accountListQuery("p2"));
    expect(p1.map((a) => a.id)).toEqual(["a1"]);
    expect(p2.map((a) => a.id)).toEqual(["b1"]);
    expect(server.listAccounts).toHaveBeenCalledWith({ data: { portfolioId: "p1" } });
  });

  it("浏览器里失败不认命:超过默认 5 次仍继续重试,直到拿到", async () => {
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
  it("窗口档位进 key,现算的起点不进:同档位换起点仍命中同一份缓存", async () => {
    const base = { accountId: "a1", range: "30d" as const, connectorId: "binance" as const };
    await qc.fetchQuery(accountHistoryQuery({ ...base, since: 1000 }));
    await qc.fetchQuery(accountHistoryQuery({ ...base, since: 2000 }));
    expect(server.getAccountHistory).toHaveBeenCalledTimes(1);
    await qc.fetchQuery(accountHistoryQuery({ ...base, range: "all", since: undefined }));
    expect(server.getAccountHistory).toHaveBeenCalledTimes(2);
  });

  it("请求带上起点、窗口与 connectorId(服务端据此分流)", async () => {
    const out = await qc.fetchQuery(
      accountHistoryQuery({ accountId: "a1", range: "7d", since: 42, connectorId: "manual" }),
    );
    expect(server.getAccountHistory).toHaveBeenCalledWith({
      data: { accountId: "a1", since: 42, connectorId: "manual", range: "7d" },
    });
    expect(out).toEqual({ points: [] });
  });

  it("单个持仓的历史:按 holdingKey 请求,同样只按窗口进 key", async () => {
    await qc.fetchQuery(holdingHistoryQuery({ holdingKey: "tok:eth", range: "1y", since: 5 }));
    await qc.fetchQuery(holdingHistoryQuery({ holdingKey: "tok:eth", range: "1y", since: 9 }));
    expect(server.getTokenValueHistory).toHaveBeenCalledTimes(1);
    expect(server.getTokenValueHistory).toHaveBeenCalledWith({
      data: { key: "tok:eth", since: 5, range: "1y" },
    });
  });

  it("手记账户明细按 accountId 请求", async () => {
    await qc.fetchQuery(manualAccountQuery("m1"));
    expect(server.getManualAccount).toHaveBeenCalledWith({ data: { accountId: "m1" } });
  });
});

describe("组合域读取", () => {
  it("组合清单在浏览器里同样永不放弃重试", async () => {
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

  it("走势缺省是 30 天窗口", async () => {
    await qc.fetchQuery(portfolioHistoryQuery("p1"));
    expect(server.getPortfolioHistory).toHaveBeenCalledWith({
      data: { portfolioId: "p1", range: "30d" },
    });
    expect(qc.getQueryData(portfolioHistoryQuery("p1", "30d").queryKey)).toEqual({ points: [] });
  });

  it("tab 条 pin 原料按组合请求", async () => {
    await qc.fetchQuery(portfolioTabPinsQuery("p1"));
    expect(server.getPortfolioTabPins).toHaveBeenCalledWith({ data: { portfolioId: "p1" } });
  });
});

describe("fetchHomeTabStrip —— pin 写后刷 tab 条", () => {
  it("pins 与标签无视缓存重拉:新钉的 tag pin 带着最新的标签名出现", async () => {
    world.accounts = { p1: [account({ id: "a1" })] };
    world.accountTags = [{ accountId: "a1", tagId: "t1" }];
    // 缓存里是写之前的样子:还没有 pin,标签叫旧名字(且仍在 staleTime 内)。
    qc.setQueryData(portfolioTabPinsQuery("p1").queryKey, { pins: [], connectorMeta: [] });
    qc.setQueryData(tagListQuery("p1").queryKey, [tag("t1", "Old")]);
    // 服务端已是写之后的样子。
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

  it("指向已不在本组合的账户的 pin 不出现;只有归档账户 → 视为没有账户", async () => {
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

describe("fetchPortfolioSnapshotAtoms —— 非 hook 路径的快照原料", () => {
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

  it("只收活跃账户;口径 / 法币参考 / 平台元数据随原料带出", async () => {
    const raw = await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(raw.accounts.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(raw.snapshots.map(([id]) => id)).toEqual(["a1", "a2"]);
    expect(raw.mode).toBe("source-first");
    expect(raw.fiatRefs).toEqual([["usd-token", "fiat/issued:USD"]]);
    expect(raw.platformMeta).toEqual([["arbitrum", { name: "Arbitrum" }]]);
    expect(raw.now).toBe(Math.floor(T0 / HOUR) * HOUR);
  });

  it("场馆展示名只取在用的(目录里多余的、归档账户的不带);链键交给 platformMeta 去解析", async () => {
    const raw = await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(raw.connectorMeta).toEqual([["binance", { name: "Binance", logo: "/b.png" }]]);
    expect(server.resolvePlatformMeta).toHaveBeenCalledWith({ data: { chainIds: ["arbitrum"] } });
  });

  it("富化字典瘦身成展示要的字段", async () => {
    const raw = await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(raw.enriched).toEqual([
      ["eth", { id: "eth", symbol: "ETH", name: "Ether", price: 25, hasLogo: true }],
    ]);
  });

  it("快照 key 用整点锚:同一小时内再取复用缓存,跨过整点才重拉", async () => {
    await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(server.getSnapshots).toHaveBeenCalledTimes(2); // 当下 + 24h 前
    vi.setSystemTime(T0 + 10 * 60_000); // 10:15
    await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(server.getSnapshots).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + 60 * 60_000); // 11:05
    await fetchPortfolioSnapshotAtoms(qc, "p1");
    expect(server.getSnapshots).toHaveBeenCalledTimes(4);
  });
});
