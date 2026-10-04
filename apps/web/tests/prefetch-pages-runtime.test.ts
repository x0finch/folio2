import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAIN_START_FLOOR_MS, GAIN_WINDOW_MS } from "@/lib/core/portfolio";
import { account, resetWorld, server, world } from "./helpers/fake-portfolio-server";

// 各 page 的数据预取(loader 与切换器预热共用)**真跑一遍**:每页往缓存里发了哪些查询、
// 发出即返回不等结果、以及预取的 key 与页面真正去读的 key 对得上(对不上 = 首屏白拉一遍)。
// 源码文本层面的「取什么 / 不 await」由 home-loader 等测试钉;这里钉的是运行出来的结果。

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

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 4, 10, 25);
const ANCHOR = Math.floor(T0 / HOUR) * HOUR;

// 期望的 key(手写字面量,不经 keys.ts 工厂 —— 工厂写错的话两边一起错,断言就空了)。
const OVERVIEW_ATOMS = [
  ["accounts", "list", "p1"],
  ["tags", "account-links", "p1"],
  ["portfolio", "snapshots", "p1", ANCHOR, null],
  ["portfolio", "snapshots", "p1", ANCHOR - GAIN_WINDOW_MS, ANCHOR - GAIN_START_FLOOR_MS],
  ["settings", "valuation"],
  ["tokens", "enrichment"],
  ["connectors", "catalogue"],
  ["portfolio", "fiat-refs", "p1"],
];

let qc: QueryClient;

const keysInCache = () =>
  qc
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey))
    .sort();
const asSorted = (keys: unknown[][]) => keys.map((k) => JSON.stringify(k)).sort();

// 让发出去的请求都落地(fake 只伪造 Date,微任务照常)。
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetWorld();
  qc = new QueryClient();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

// 不 `qc.clear()`:那会取消还在路上的预取,而预取是发出即忘的 —— 取消会变成没人接的拒绝。
afterEach(() => {
  vi.useRealTimers();
});

describe("各页预取发了哪些查询", () => {
  it("总览:八条共同原料 + tab pin / 标签清单 / 30 天走势", () => {
    prefetchOverview(qc, "p1");
    expect(keysInCache()).toEqual(
      asSorted([
        ...OVERVIEW_ATOMS,
        ["portfolio", "tabs", "pins", "p1"],
        ["tags", "list", "p1"],
        ["portfolio", "history", "p1", "30d"],
      ]),
    );
  });

  it("洞察:同一批原料 + 全程走势;不取 tab pin 与标签清单", () => {
    prefetchInsights(qc, "p1");
    expect(keysInCache()).toEqual(
      asSorted([...OVERVIEW_ATOMS, ["portfolio", "history", "p1", "all"]]),
    );
  });

  it("账户页:目录 / 账户 / 标签 / 归属 / 两张快照 / 口径 / 富化;不取法币参考与走势", () => {
    prefetchAccounts(qc, "p1");
    expect(keysInCache()).toEqual(
      asSorted([
        ["connectors", "catalogue"],
        ["accounts", "list", "p1"],
        ["tags", "list", "p1"],
        ["tags", "account-links", "p1"],
        ["portfolio", "snapshots", "p1", ANCHOR, null],
        ["portfolio", "snapshots", "p1", ANCHOR - GAIN_WINDOW_MS, ANCHOR - GAIN_START_FLOOR_MS],
        ["settings", "valuation"],
        ["tokens", "enrichment"],
      ]),
    );
  });

  it("设置页:三条与组合无关的设置", () => {
    prefetchSettings(qc);
    expect(keysInCache()).toEqual(
      asSorted([
        ["settings", "provider-keys"],
        ["settings", "valuation"],
        ["settings", "data-stats"],
      ]),
    );
  });
});

describe("发出即返回", () => {
  it("请求还在路上时预取函数已经返回(不是 Promise)", () => {
    server.getSnapshots.mockImplementation(() => new Promise(() => {}));
    expect(prefetchOverview(qc, "p1")).toBeUndefined();
    expect(prefetchInsights(qc, "p1")).toBeUndefined();
    expect(prefetchAccounts(qc, "p1")).toBeUndefined();
    expect(prefetchSettings(qc)).toBeUndefined();
    expect(server.getSnapshots).toHaveBeenCalled();
  });
});

describe("预取的 key 与页面读的 key 对得上", () => {
  it("总览预取之后,同一小时内组装快照原料不再回服务器取原料", async () => {
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
