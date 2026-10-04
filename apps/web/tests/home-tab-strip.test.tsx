import { toast } from "@folio/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTabStripView } from "@/lib/core/portfolio";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";
import type { PinScopeKey } from "@/lib/queries/keys";
import type { PortfolioOverview } from "@/lib/queries/portfolio";

// 首页 tab 条(视角 tab + 自定义 Tab + ＋ 加钮 + 右侧合计)从用户这一侧看:
//   · 视角 tab:Tokens 恒在;Perps / DeFi 只在组合里真有时才出;pin 以 `#名` / `@名` 显示
//   · 右侧合计跟着选中的 tab 走:tokens → 现货小计、perps → 永续权益小计、defi → DeFi 小计;
//     选中 pin → 按 pin 另拉一份总览取它的总额;还在取 → 骨架;失败 → `—`;开隐私 → 被遮
//   · ＋ 加钮:点开选择器(选项只来自当前组合、不含归档账户、连接器去重);选一项 → createTabPin,
//     等条子上真挂上了新 tab 再选中它;失败 → toast;已满 3 个 → ＋ 不出现
//   · pin 本身:**先选中、再点才开管理面板**;面板里改指向 → updateTabPinTarget,取消固定 →
//     deleteTabPin,且取消的是当前选中的 → 选中挪到左邻(前一个 pin,没有就最后一个视角 tab)
//   · 面板浮层:窗口 resize → 关;桌面 hover:选中的 pin 移上去即开、未选中的不开
// 数据钩子与 server fn 打桩;写完之后「等条子变了」那一步(fetchHomeTabStrip)也打桩成立刻就绪。

const h = vi.hoisted(() => ({
  strip: {
    current: { hasAccounts: true, hasPerps: false, hasDefi: false, pins: [] } as HomeTabStripView,
  },
  overview: vi.fn<(portfolioId: string, pin?: PinScopeKey) => PortfolioOverview>(),
  createTabPin: vi.fn(),
  deleteTabPin: vi.fn(),
  updateTabPinTarget: vi.fn(),
  fetchHomeTabStrip: vi.fn(),
  listConnectors: vi.fn(),
  listAccounts: vi.fn(),
  listTags: vi.fn(),
}));

vi.mock("@/lib/hooks/use-portfolio", () => ({ usePortfolio: () => ({ selectedId: "p1" }) }));
vi.mock("@/lib/hooks/use-home-tab-strip", () => ({ useHomeTabStrip: () => h.strip.current }));
vi.mock("@/lib/queries/portfolio-overview-compose", () => ({
  usePortfolioOverview: (id: string, pin?: PinScopeKey) => h.overview(id, pin),
}));
vi.mock("@/lib/queries/portfolio", () => ({ fetchHomeTabStrip: h.fetchHomeTabStrip }));
vi.mock("@/lib/server/tab-pins", () => ({
  createTabPin: h.createTabPin,
  deleteTabPin: h.deleteTabPin,
  updateTabPinTarget: h.updateTabPinTarget,
}));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors: h.listConnectors,
  getConnectorCredentialSpecs: vi.fn(),
}));
vi.mock("@/lib/server/accounts", () => ({
  listAccounts: h.listAccounts,
  getAccountHistory: vi.fn(),
}));
vi.mock("@/lib/server/manual-tokens", () => ({ getManualAccount: vi.fn() }));
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory: vi.fn() }));
vi.mock("@/lib/server/tags", () => ({ listTags: h.listTags, listAccountTags: vi.fn() }));

const { TabStripIsland } = await import("@/routes/_authed/-home/tab");
const { HomeViewStateProvider, useHomeViewState } = await import(
  "@/routes/_authed/-home/view-state"
);

type Pin = HomeTabStripView["pins"][number];
const tagPin: Pin = { id: "pin1", kind: "tag", tagId: "t1", name: "DeFi" };
const acctPin: Pin = { id: "pin2", kind: "account", accountId: "a1", name: "Cold" };

const overview = (over: Partial<PortfolioOverview> = {}): PortfolioOverview => ({
  holdings: [],
  sections: [
    {
      account: { id: "hl", label: "Main" },
      defi: [],
      perp: {
        equity: { accountValue: 300, withdrawable: 0, totalMarginUsed: 0, totalNtlPos: 0 },
        positions: [],
      },
    },
  ],
  accountTotals: [],
  totalUsd: 1_815,
  holdingsSubtotal: 1_500,
  defiSubtotal: 15,
  pending: false,
  ...over,
});

beforeEach(() => {
  h.strip.current = { hasAccounts: true, hasPerps: true, hasDefi: true, pins: [] };
  h.overview.mockReset();
  h.overview.mockImplementation((_id, pin) => (pin ? overview({ totalUsd: 42 }) : overview()));
  h.createTabPin.mockReset();
  h.deleteTabPin.mockReset();
  h.updateTabPinTarget.mockReset();
  h.fetchHomeTabStrip.mockReset();
  // 「等条子真的变了」:直接给一份已经变好的条子 —— 新 pin 在、被删的不在、改指向的已改。
  h.fetchHomeTabStrip.mockImplementation(async () => h.strip.current);
  h.listConnectors.mockReset();
  h.listConnectors.mockResolvedValue({ binance: { label: "Binance" } });
  h.listAccounts.mockReset();
  h.listAccounts.mockImplementation(
    async () =>
      new Response(
        JSON.stringify([
          { id: "a1", label: "Cold", connectorId: "binance", archivedAt: null },
          { id: "a2", label: "Hot", connectorId: "binance", archivedAt: null },
          { id: "a3", label: "Old", connectorId: "okx", archivedAt: 1 },
        ]),
      ),
  );
  h.listTags.mockReset();
  h.listTags.mockResolvedValue([{ id: "t1", name: "DeFi" }]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let currentTab = "";
function TabProbe() {
  currentTab = useHomeViewState().tab;
  return null;
}

function mount(opts: { hide?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <HomeViewStateProvider>
          <TabProbe />
          <TabStripIsland />
        </HomeViewStateProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
  return render(
    opts.hide == null ? (
      tree
    ) : (
      <BalancePrivacyProvider hideBalances={opts.hide}>{tree}</BalancePrivacyProvider>
    ),
  );
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
const selectedTab = () =>
  screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
const tab = (name: string) => screen.getByRole("tab", { name });
// 右侧合计:tab 条之外、紧挨着它的那一格。
const total = (container: HTMLElement) =>
  (container.querySelector("[role=tablist]")?.closest(".flex.items-center.gap-4") as HTMLElement)
    .lastElementChild as HTMLElement;
const addButton = () => screen.queryByRole("button", { name: "Pin a view" });
const unpinButton = () => screen.queryByRole("button", { name: "Unpin" });
// 浮层的开合态(beUI 触发器上的 aria-expanded)。关上之后浮层还要等收拢动画放完才卸载,
// 所以「没关」要看这个,不能只看 Unpin 还在不在 DOM 里。
const panelExpanded = () =>
  document.querySelector("[aria-haspopup=dialog]")?.getAttribute("aria-expanded");

describe("tab 条", () => {
  it("Tokens 恒在;Perps / DeFi 跟着组合有没有;pin 带 #/@ 前缀", () => {
    h.strip.current = { ...h.strip.current, pins: [tagPin, acctPin] };
    mount();
    expect(tabNames()).toEqual(["Tokens", "Perps", "DeFi", "#DeFi", "@Cold"]);
  });

  it("组合里没有永续 / DeFi → 只剩 Tokens", () => {
    h.strip.current = { ...h.strip.current, hasPerps: false, hasDefi: false };
    mount();
    expect(tabNames()).toEqual(["Tokens"]);
  });

  it("默认选中 Tokens;点别的 tab 就选中它", () => {
    mount();
    expect(selectedTab()).toBe("Tokens");
    fireEvent.click(tab("Perps"));
    expect(selectedTab()).toBe("Perps");
    expect(currentTab).toBe("perps");
  });
});

describe("右侧合计", () => {
  it("跟着视角 tab 走:现货小计 / 永续权益小计 / DeFi 小计", () => {
    const { container } = mount();
    expect(total(container).textContent).toBe("$1,500.00");
    fireEvent.click(tab("Perps"));
    expect(total(container).textContent).toBe("$300.00");
    fireEvent.click(tab("DeFi"));
    expect(total(container).textContent).toBe("$15.00");
  });

  it("选中 pin → 按 pin 的目标另拉总览,显示那份的总额", () => {
    h.strip.current = { ...h.strip.current, pins: [tagPin] };
    const { container } = mount();
    fireEvent.click(tab("#DeFi"));
    expect(h.overview).toHaveBeenCalledWith("p1", { kind: "tag", tagId: "t1" });
    expect(total(container).textContent).toBe("$42.00");
  });

  it("pin 那份还在取 → 骨架,不显未收窄的全量总额", () => {
    h.strip.current = { ...h.strip.current, pins: [tagPin] };
    h.overview.mockImplementation((_id, pin) => {
      if (pin) throw new Promise(() => {});
      return overview();
    });
    const { container } = mount();
    fireEvent.click(tab("#DeFi"));
    expect(total(container).textContent).toBe("");
    expect(total(container).querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("取总额失败 → `—`", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.overview.mockImplementation(() => {
      throw new Error("boom");
    });
    const { container } = mount();
    expect(total(container).textContent).toBe("—");
  });

  it("开隐私 → 合计被遮", () => {
    const { container } = mount({ hide: true });
    expect(
      within(total(container)).getByRole("button", { name: /balance hidden/i }).textContent,
    ).toBe("$1,500.00");
  });
});

describe("＋ 固定一个视图", () => {
  it("已满 3 个 → ＋ 不出现", () => {
    h.strip.current = {
      ...h.strip.current,
      pins: [tagPin, acctPin, { id: "pin3", kind: "connector", connectorId: "okx", name: "OKX" }],
    };
    mount();
    expect(addButton()).toBeNull();
  });

  it("点 ＋ → 选择器:选项只来自当前组合的活跃账户,连接器去重,归档的不出现", async () => {
    mount();
    expect(screen.queryByText("Tags")).toBeNull(); // 关着时不拉、不渲染
    fireEvent.click(addButton() as HTMLElement);
    await screen.findByRole("button", { name: "@Cold" });
    expect(screen.getByRole("button", { name: "#DeFi" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "@Hot" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "@Old" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Binance" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "OKX" })).toBeNull();
    expect(h.listAccounts).toHaveBeenCalledWith({ data: { portfolioId: "p1" } });
    expect(h.listTags).toHaveBeenCalledWith({ data: { portfolioId: "p1" } });
  });

  it("选一项 → createTabPin;条子上挂上新 tab 之后选中它", async () => {
    h.createTabPin.mockImplementation(async () => {
      h.strip.current = { ...h.strip.current, pins: [acctPin] };
      return acctPin;
    });
    mount();
    fireEvent.click(addButton() as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "@Cold" }));
    await waitFor(() =>
      expect(h.createTabPin).toHaveBeenCalledWith({ data: { kind: "account", accountId: "a1" } }),
    );
    await waitFor(() => expect(currentTab).toBe("pin2"));
    expect(h.fetchHomeTabStrip).toHaveBeenCalled();
  });

  it("刷新回来的条子上还没有新 tab → 先等,真挂上了才选中(否则药丸指向一个不存在的 tab)", async () => {
    const before = h.strip.current;
    h.createTabPin.mockResolvedValue(acctPin);
    h.fetchHomeTabStrip
      .mockImplementationOnce(async () => before) // 第一次刷新:还是旧条子
      .mockImplementation(async () => ({ ...before, pins: [acctPin] }));
    mount();
    fireEvent.click(addButton() as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "@Cold" }));
    await waitFor(() => expect(h.fetchHomeTabStrip).toHaveBeenCalledTimes(1));
    expect(currentTab).toBe("tokens");
    await waitFor(() => expect(currentTab).toBe("pin2"), { timeout: 5_000 });
    expect(h.fetchHomeTabStrip).toHaveBeenCalledTimes(2);
  });

  it("创建失败 → toast 报错,不切 tab", async () => {
    const err = vi.spyOn(toast, "error").mockImplementation(() => "");
    h.createTabPin.mockRejectedValue(new Error("cap"));
    mount();
    fireEvent.click(addButton() as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "#DeFi" }));
    await waitFor(() => expect(err).toHaveBeenCalledWith("Something went wrong."));
    expect(currentTab).toBe("tokens");
  });

  it("选择器的数据拉不到 → 面板里说失败,不是空白", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.listTags.mockRejectedValue(new Error("down"));
    mount();
    fireEvent.click(addButton() as HTMLElement);
    expect(await screen.findByText("Something went wrong.")).toBeTruthy();
  });
});

describe("pin 的管理面板", () => {
  beforeEach(() => {
    h.strip.current = { ...h.strip.current, pins: [tagPin, acctPin] };
  });

  it("没选中的 pin:第一下只选中、不开面板;再点才开", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    expect(selectedTab()).toBe("#DeFi");
    expect(unpinButton()).toBeNull();
    fireEvent.click(tab("#DeFi"));
    expect(await screen.findByRole("button", { name: "Unpin" })).toBeTruthy();
  });

  it("面板开着再点一下 → 关", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    await screen.findByRole("button", { name: "Unpin" });
    fireEvent.click(tab("#DeFi"));
    await waitFor(() => expect(unpinButton()).toBeNull());
  });

  it("改指向 → updateTabPinTarget 带着 pin id 与新目标;面板随即关上", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(await screen.findByRole("button", { name: "@Hot" }));
    await waitFor(() =>
      expect(h.updateTabPinTarget).toHaveBeenCalledWith({
        data: { pinId: "pin1", kind: "account", accountId: "a2" },
      }),
    );
    await waitFor(() => expect(unpinButton()).toBeNull());
  });

  it("取消固定当前选中的 → deleteTabPin,选中挪到左邻的 pin", async () => {
    mount();
    fireEvent.click(tab("@Cold"));
    fireEvent.click(tab("@Cold"));
    fireEvent.click(await screen.findByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(h.deleteTabPin).toHaveBeenCalledWith({ data: { pinId: "pin2" } }));
    expect(currentTab).toBe("pin1");
  });

  it("最左边那个 pin 被取消 → 选中落到最后一个视角 tab", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(await screen.findByRole("button", { name: "Unpin" }));
    expect(currentTab).toBe("defi");
  });

  it("删除失败 → toast 报错", async () => {
    const err = vi.spyOn(toast, "error").mockImplementation(() => "");
    h.deleteTabPin.mockRejectedValue(new Error("x"));
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(await screen.findByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(err).toHaveBeenCalledWith("Something went wrong."));
  });

  it("窗口 resize → 浮层与触发器脱节了,关掉", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    await screen.findByRole("button", { name: "Unpin" });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(unpinButton()).toBeNull());
  });

  it("触发器被滚走了 → 关;面板自己内部滚动(选择器 overflow)→ 不关", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    const unpin = await screen.findByRole("button", { name: "Unpin" });
    // 打开之后触发器「挪了位置」:jsdom 没有几何,这里让它量出来跟打开时不一样。
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 50, 60, 32),
    );
    act(() => {
      unpin.parentElement?.dispatchEvent(new Event("scroll"));
    });
    expect(panelExpanded()).toBe("true");
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(unpinButton()).toBeNull());
  });

  it("触发器没挪(开面板时自己滚进可视区那一下)→ 不关", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    await screen.findByRole("button", { name: "Unpin" });
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(panelExpanded()).toBe("true");
  });

  it("按 Esc / 点面板外面 → 关", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    await screen.findByRole("button", { name: "Unpin" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(unpinButton()).toBeNull());

    fireEvent.click(tab("#DeFi"));
    await screen.findByRole("button", { name: "Unpin" });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(unpinButton()).toBeNull());
  });

  it("桌面 hover:选中的 pin 移上去即开,移开一会儿后关;没选中的移上去不开", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(hover: hover)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    mount();
    const wrapperOf = (name: string) => tab(name).closest("span.inline-flex") as HTMLElement;

    fireEvent.mouseEnter(wrapperOf("#DeFi"));
    expect(unpinButton()).toBeNull(); // 没选中

    fireEvent.click(tab("#DeFi")); // 选中(触屏 tap 同路:首点不开)
    fireEvent.mouseLeave(wrapperOf("#DeFi"));
    fireEvent.mouseEnter(wrapperOf("#DeFi"));
    expect(await screen.findByRole("button", { name: "Unpin" })).toBeTruthy();

    fireEvent.mouseLeave(wrapperOf("#DeFi"));
    await waitFor(() => expect(unpinButton()).toBeNull());
  });
});
