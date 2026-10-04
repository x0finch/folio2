import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTabStripView } from "@/lib/core/portfolio";
import { messages } from "@/lib/i18n/messages";
import type { PinScopeKey } from "@/lib/queries/keys";
import type { PortfolioOverview } from "@/lib/queries/portfolio";

// 首页下半截「持仓岛」:按当前选中的 tab 渲染哪份内容。
//   · 没有账户 → 什么都不渲染(空态归页面那句「还没有账户」管)
//   · 视角 tab:tokens → 代币列表(没持仓 → 「No snapshot yet」);perps → 只列真有仓位 / 权益的账户;
//     defi → 跨账户按协议合并后的列表、不带节头;认不出的 tab 值 → 回落 tokens
//   · 自定义 Tab(pin):按 pin 的目标另拉一份总览(断言拉的是哪个 scope);空 → 「No accounts match」;
//     有 → 三段(Tokens / Perps / DeFi)按小计排;还在取 → 骨架;失败 → 「Something went wrong.」
//   · `derive`:永续权益小计 = 各账户权益之和(tab 条右侧合计也用它)
// 数据钩子(组合选择 / tab 条 / 总览)打桩:它们背后是 server fn 与 query 编排,这里只看这一层怎么分支。

const h = vi.hoisted(() => ({
  strip: {
    current: { hasAccounts: true, hasPerps: true, hasDefi: true, pins: [] } as HomeTabStripView,
  },
  overview: vi.fn<(portfolioId: string, pin?: PinScopeKey) => PortfolioOverview>(),
}));

vi.mock("@/lib/hooks/use-portfolio", () => ({ usePortfolio: () => ({ selectedId: "p1" }) }));
vi.mock("@/lib/hooks/use-home-tab-strip", () => ({ useHomeTabStrip: () => h.strip.current }));
vi.mock("@/lib/queries/portfolio-overview-compose", () => ({
  usePortfolioOverview: (id: string, pin?: PinScopeKey) => h.overview(id, pin),
}));
// 代币抽屉的历史查询模块会拉进这几个 server fn 模块;只挡住加载。
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory: vi.fn() }));
vi.mock("@/lib/server/accounts", () => ({ listAccounts: vi.fn(), getAccountHistory: vi.fn() }));
vi.mock("@/lib/server/manual-tokens", () => ({ getManualAccount: vi.fn() }));

const { HoldingsIsland, derive } = await import("@/routes/_authed/-home/holdings");
const { HomeViewStateProvider, useHomeViewState } = await import(
  "@/routes/_authed/-home/view-state"
);

const perpView = (equity: number) => ({
  equity: { accountValue: equity, withdrawable: 0, totalMarginUsed: 0, totalNtlPos: 0 },
  positions: [],
});

const overview = (over: Partial<PortfolioOverview> = {}): PortfolioOverview => ({
  holdings: [
    {
      key: "btc",
      token: { symbol: "BTC", name: "Bitcoin" },
      totalValue: 500,
      totalAmount: 0.01,
      gain24h: null,
      sources: [],
    },
  ],
  sections: [
    {
      account: { id: "hl", label: "Main", platform: { name: "Hyperliquid" } },
      defi: [],
      perp: perpView(300),
    },
    {
      account: { id: "w1", label: "Wallet" },
      defi: [{ protocol: "Aave", rows: [{ id: "r1", symbol: "USDC", amount: 10, usdValue: 10 }] }],
      perp: null,
    },
    {
      account: { id: "w2", label: "Wallet 2" },
      defi: [{ protocol: "Aave", rows: [{ id: "r2", symbol: "DAI", amount: 5, usdValue: 5 }] }],
      // 空壳永续(无仓位、无权益)→ 不该在永续 tab 里占一块
      perp: { equity: null, positions: [] },
    },
  ],
  accountTotals: [],
  totalUsd: 815,
  holdingsSubtotal: 500,
  defiSubtotal: 15,
  pending: false,
  ...over,
});

beforeEach(() => {
  h.strip.current = { hasAccounts: true, hasPerps: true, hasDefi: true, pins: [] };
  h.overview.mockReset();
  h.overview.mockImplementation(() => overview());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// 测试用的 tab 切换器:直接写首页的页内 tab 状态(真实页面里是 tab 条在写它)。
let setTab: (v: string) => void = () => {};
function TabHandle() {
  setTab = useHomeViewState().setTab;
  return null;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <HomeViewStateProvider>
          <TabHandle />
          <HoldingsIsland />
        </HomeViewStateProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  const go = (tab: string) =>
    act(() => {
      setTab(tab);
    });
  return { ...r, go };
}

describe("视角 tab", () => {
  it("没有账户 → 什么都不渲染", () => {
    h.strip.current = { ...h.strip.current, hasAccounts: false };
    const { container } = mount();
    expect(container.textContent).toBe("");
  });

  it("默认 tokens → 代币列表", () => {
    mount();
    expect(screen.getByText("Bitcoin")).toBeTruthy();
  });

  it("tokens 但一个持仓都没有 → 「No snapshot yet」", () => {
    h.overview.mockImplementation(() => overview({ holdings: [] }));
    mount();
    expect(screen.getByText(/No snapshot yet/)).toBeTruthy();
  });

  it("perps → 只列真有权益 / 仓位的账户", () => {
    const { go } = mount();
    go("perps");
    expect(screen.getByText("Hyperliquid")).toBeTruthy();
    expect(screen.queryByText("Wallet 2")).toBeNull();
    expect(screen.queryByText("Bitcoin")).toBeNull();
  });

  it("defi → 跨账户按协议合并成一行,不带节头", () => {
    const { go, container } = mount();
    go("defi");
    expect(screen.getAllByText("Aave", { selector: ".truncate" })).toHaveLength(1);
    expect(container.textContent).toContain("$15.00"); // 10 + 5 合并
    expect(screen.queryByText("DeFi positions")).toBeNull();
  });

  it("认不出的 tab 值(比如被删掉的 pin)→ 回落到 tokens", () => {
    const { go } = mount();
    go("pin-that-is-gone");
    expect(screen.getByText("Bitcoin")).toBeTruthy();
  });

  it("选着 perps 但这个组合已经没有永续了 → 回落到 tokens,不留空白", () => {
    h.strip.current = { ...h.strip.current, hasPerps: false };
    const { go } = mount();
    go("perps");
    expect(screen.getByText("Bitcoin")).toBeTruthy();
    expect(screen.queryByText("Hyperliquid")).toBeNull();
  });

  it("视角 tab 只拉组合的那份总览,不带 pin scope", () => {
    mount();
    expect(h.overview).toHaveBeenCalledWith("p1", undefined);
    expect(h.overview.mock.calls.every(([, pin]) => pin === undefined)).toBe(true);
  });
});

describe("自定义 Tab(pin)", () => {
  beforeEach(() => {
    h.strip.current = {
      ...h.strip.current,
      pins: [{ id: "pin1", kind: "tag", tagId: "t1", name: "DeFi" }],
    };
  });

  it("按 pin 的目标另拉一份总览", () => {
    const { go } = mount();
    go("pin1");
    expect(h.overview).toHaveBeenCalledWith("p1", { kind: "tag", tagId: "t1" });
  });

  it("那份总览是空的 → 「No accounts match this tab yet.」", () => {
    h.overview.mockImplementation((_id, pin) =>
      pin ? overview({ holdings: [], sections: [] }) : overview(),
    );
    const { go } = mount();
    go("pin1");
    expect(screen.getByText("No accounts match this tab yet.")).toBeTruthy();
  });

  it("有内容 → 三段按小计排(最大那段省节头),内容来自 pin 那份", () => {
    h.overview.mockImplementation((_id, pin) =>
      pin
        ? overview({
            holdings: [
              {
                key: "eth",
                token: { symbol: "ETH", name: "Ether" },
                totalValue: 50,
                gain24h: null,
                sources: [],
              },
            ],
            holdingsSubtotal: 50,
          })
        : overview(),
    );
    const { go } = mount();
    go("pin1");
    expect(screen.getByText("Ether")).toBeTruthy();
    expect(screen.queryByText("Bitcoin")).toBeNull();
    // 永续 300 > 代币 50 > DeFi 15:最大的永续段省节头,后两段有。
    expect(screen.queryByText("Perps")).toBeNull();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.getByText("DeFi")).toBeTruthy();
  });

  it("pin 那份还在取 → 骨架,不先闪组合的全量列表", () => {
    h.overview.mockImplementation((_id, pin) => {
      if (pin) throw new Promise(() => {});
      return overview();
    });
    const { go, container } = mount();
    go("pin1");
    expect(screen.queryByText("Bitcoin")).toBeNull();
    expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("pin 那份失败 → 「Something went wrong.」,不塌整页", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.overview.mockImplementation((_id, pin) => {
      if (pin) throw new Error("boom");
      return overview();
    });
    const { go } = mount();
    go("pin1");
    expect(screen.getByText("Something went wrong.")).toBeTruthy();
  });
});

describe("derive", () => {
  it("永续权益小计 = 有永续的各账户权益之和;空壳永续不算一项", () => {
    const parts = derive(
      overview({
        sections: [
          { account: { id: "a", label: "A" }, defi: [], perp: perpView(300) },
          { account: { id: "b", label: "B" }, defi: [], perp: perpView(200) },
          { account: { id: "c", label: "C" }, defi: [], perp: { equity: null, positions: [] } },
        ],
      }).sections,
    );
    expect(parts.perpEquitySubtotal).toBe(500);
    expect(parts.perpItems.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
