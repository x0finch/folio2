import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Holding, HoldingSource } from "@/lib/core/portfolio";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";

// 首页代币列表 + 代币详情抽屉:
//   · 列表:少于 10 个持仓全展开;≥ 10 个时 < $1 的小额收进「N small holdings」,点开 / 收起
//   · 点一行 → 抽屉打开那个币:名称、排名 + 单价徽标、总数量、24h 盈亏(算不出 → `—`)
//   · 抽屉按 holding key + 窗口拉单币价值历史(默认 30D,切 7D 重拉);拉回两点以上 → 画图,不摆文案
//   · 来源两视图:按平台(副行点名 `@账户`,超过 3 个显 2 个 + `+n`;唯一账户与平台同名则省副行)/
//     按账户(副行写平台名或「N sources」);右侧数量 + 占比(≥ 10% 取整,否则一位小数)
//   · 桌面走右滑 Drawer(以币名为可读标签),手机走 BottomSheet —— 同一份内容
//   · 隐私:抽屉里的数量被遮
// 历史接口是 server fn → 打桩,并断言它被以什么参数调用。

const { getTokenValueHistory } = vi.hoisted(() => ({
  getTokenValueHistory: vi.fn(),
}));
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory }));
// accounts 查询模块顺带拉进这两个 server fn 模块;这里用不到,只挡住它们在 jsdom 里加载。
vi.mock("@/lib/server/accounts", () => ({ listAccounts: vi.fn(), getAccountHistory: vi.fn() }));
vi.mock("@/lib/server/manual-tokens", () => ({ getManualAccount: vi.fn() }));

const { TokenHoldings } = await import("@/routes/_authed/-home/holdings/tokens");
const { HomeViewStateProvider } = await import("@/routes/_authed/-home/view-state");

const DAY = 86_400_000;
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));

const src = (
  platform: string,
  account: string,
  amount: number,
  value: number,
  platformName = platform,
  accountLabel = account,
): HoldingSource => ({
  platform: { id: platform, name: platformName },
  account: { id: account, label: accountLabel },
  amount,
  value,
  kind: "spot",
});

const btc: Holding = {
  key: "btc",
  token: { symbol: "BTC", name: "Bitcoin", unitPrice: 60_000, marketCapRank: 1 },
  totalValue: 6_000,
  totalAmount: 0.1,
  gain24h: { amount: 100, pct: 1.7 },
  sources: [
    src("binance", "a1", 0.06, 3_600, "Binance", "Main"),
    src("bitcoin", "a2", 0.04, 2_400, "Bitcoin", "Cold"),
  ],
};

const coin = (i: number, value: number): Holding => ({
  key: `t${i}`,
  token: { symbol: `T${i}`, name: `Token ${i}` },
  totalValue: value,
  totalAmount: 1,
  gain24h: null,
  sources: [src("eth", "a1", 1, value)],
});

beforeEach(() => {
  getTokenValueHistory.mockReset();
  getTokenValueHistory.mockImplementation(async () => jsonResponse({ rows: [] }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(holdings: Holding[], opts: { hide?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <HomeViewStateProvider>
          <TokenHoldings holdings={holdings} />
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

const rowNames = () =>
  screen
    .queryAllByRole("button")
    .map((b) => b.querySelector(".truncate.font-medium")?.textContent)
    .filter(Boolean);

const openRow = (name: string) =>
  fireEvent.click(screen.getByText(name, { selector: "span" }).closest("button") as HTMLElement);

const sheetHeading = () => screen.getByRole("heading", { level: 2 });

describe("列表与小额折叠", () => {
  it("少于 10 个持仓 → 全展开,小额也在,没有折叠入口", () => {
    mount([coin(1, 500), coin(2, 0.2)]);
    expect(rowNames()).toEqual(["Token 1", "Token 2"]);
    expect(screen.queryByText(/small holdings/)).toBeNull();
  });

  it("≥ 10 个持仓 → < $1 的收起;点开显示,再点收起", () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) => coin(i, 100 + i)),
      coin(8, 0.5),
      coin(9, 0.1),
    ];
    mount(many);
    expect(rowNames()).toHaveLength(8);
    expect(rowNames()).not.toContain("Token 8");

    fireEvent.click(screen.getByText(/2 small holdings/));
    expect(rowNames()).toHaveLength(10);
    expect(rowNames().slice(-2)).toEqual(["Token 8", "Token 9"]);

    fireEvent.click(screen.getByText(/Hide small holdings/));
    expect(rowNames()).toHaveLength(8);
  });

  it("≥ 10 个但没有小额 → 不出折叠入口", () => {
    mount(Array.from({ length: 10 }, (_, i) => coin(i, 100)));
    expect(rowNames()).toHaveLength(10);
    expect(screen.queryByText(/small holdings/)).toBeNull();
  });
});

describe("代币详情抽屉", () => {
  it("没点之前不开;点一行 → 打开那个币,并按它的 key、默认 30D 窗口拉历史", async () => {
    mount([btc, coin(1, 10)]);
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(getTokenValueHistory).not.toHaveBeenCalled();

    openRow("Bitcoin");
    expect(sheetHeading().textContent).toBe("Bitcoin");
    await waitFor(() => expect(getTokenValueHistory).toHaveBeenCalledTimes(1));
    expect(getTokenValueHistory).toHaveBeenCalledWith({
      data: { key: "btc", range: "30d", since: expect.any(Number) },
    });
  });

  it("切到 7D → 用 7d 窗口重拉", async () => {
    mount([btc]);
    openRow("Bitcoin");
    await waitFor(() => expect(getTokenValueHistory).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "7D" }));
    await waitFor(() =>
      expect(getTokenValueHistory).toHaveBeenLastCalledWith({
        data: { key: "btc", range: "7d", since: expect.any(Number) },
      }),
    );
  });

  it("头部:排名 + 单价徽标、总数量、24h 盈亏与百分比", () => {
    const { baseElement } = mount([btc]);
    openRow("Bitcoin");
    const head = sheetHeading().parentElement as HTMLElement;
    expect(head.textContent).toBe("Bitcoin#1$60,000.00");
    expect(baseElement.textContent).toContain("+$100.00 1.70%");
  });

  it("24h 算不出 → `—`;没排名没单价 → 不出徽标", () => {
    mount([{ ...btc, gain24h: null, token: { symbol: "BTC", name: "Bitcoin" } }]);
    openRow("Bitcoin");
    expect((sheetHeading().parentElement as HTMLElement).textContent).toBe("Bitcoin");
    // 列表那一行一个 `—`,抽屉头部一个 `—` —— 不是 `$0.00`(「算不出」≠「没变」)。
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  // 「画了图」的判法同 trend-panel.test:那层裁溢出的包裹 div 只在真画图那一支出现。
  const chartDrawn = (c: HTMLElement) => c.querySelector(".absolute.inset-0.overflow-hidden");

  it("历史拉回是空的 → 摆「还没数据」那句,不画图", async () => {
    const { baseElement } = mount([btc]);
    openRow("Bitcoin");
    await waitFor(() => expect(screen.getByText(/once it's ready/i)).toBeTruthy());
    expect(chartDrawn(baseElement)).toBeNull();
  });

  it("历史拉回两点以上 → 画图,不再摆「还没数据」那句", async () => {
    const now = Date.now();
    getTokenValueHistory.mockImplementation(async () =>
      jsonResponse({
        rows: [
          { accountId: "a1", takenAt: now - 3 * DAY, totalUsd: 5_000 },
          { accountId: "a1", takenAt: now - DAY, totalUsd: 6_000 },
        ],
      }),
    );
    const { baseElement } = mount([btc]);
    openRow("Bitcoin");
    await waitFor(() => expect(chartDrawn(baseElement)).toBeTruthy());
    expect(screen.queryByText(/once it's ready/i)).toBeNull();
  });

  it("手机宽度 → BottomSheet;桌面宽度 → 以币名为可读标签的 Drawer", () => {
    const a = mount([btc]);
    openRow("Bitcoin");
    expect(screen.queryByRole("dialog", { name: "Bitcoin" })).toBeNull();
    a.unmount();

    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 640px)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    mount([btc]);
    openRow("Bitcoin");
    expect(screen.getByRole("dialog", { name: "Bitcoin" })).toBeTruthy();
  });
});

// 来源视图:切到那个 tab,取当前显示的那块内容(未激活的那块带 `hidden` 留在 DOM 里)。
const showPanel = (name: "Platforms" | "Accounts") => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.click(tab);
  const list = tab.closest("[role=tablist]") as HTMLElement;
  return [...(list.parentElement?.children ?? [])].find(
    (c) => c !== list && !c.hasAttribute("hidden"),
  ) as HTMLElement;
};
// 一行 = GroupRow:头像 / 主名 / 副名 / 数量 + 占比。
const panelRows = (name: "Platforms" | "Accounts") =>
  [...showPanel(name).querySelectorAll(".rounded-xl.px-3")].map((r) => r.textContent);

describe("来源两视图", () => {
  it("按平台:平台名 + `@账户`,数量与占比,按金额降序", () => {
    mount([btc]);
    openRow("Bitcoin");
    expect(panelRows("Platforms")).toEqual([
      "BBinance@Main0.06 BTC60%",
      "BBitcoin@Cold0.04 BTC40%",
    ]);
  });

  it("按账户:`@账户` 在主行,副行是平台名", () => {
    mount([btc]);
    openRow("Bitcoin");
    expect(panelRows("Accounts")).toEqual(["B@MainBinance0.06 BTC60%", "B@ColdBitcoin0.04 BTC40%"]);
  });

  it("一个平台下超过 3 个账户 → 点名前 2 个 + `+n`;账户跨多处 → 副行「N sources」", () => {
    const h: Holding = {
      ...btc,
      totalValue: 1_000,
      sources: [
        src("eth", "a", 1, 400, "Ethereum", "A"),
        src("eth", "b", 1, 300, "Ethereum", "B"),
        src("eth", "c", 1, 200, "Ethereum", "C"),
        src("eth", "d", 1, 50, "Ethereum", "D"),
        src("arb", "a", 1, 50, "Arbitrum", "A"),
      ],
    };
    mount([h]);
    openRow("Bitcoin");
    const platforms = panelRows("Platforms");
    expect(platforms[0]).toContain("Ethereum@A@B+2");
    expect(platforms[0]).not.toContain("@C");
    const accounts = panelRows("Accounts");
    expect(accounts[0]).toContain("@A2 sources");
  });

  it("占比:≥ 10% 取整,< 10% 一位小数", () => {
    const h: Holding = {
      ...btc,
      totalValue: 1_000,
      sources: [src("eth", "a", 1, 950, "Ethereum", "A"), src("arb", "b", 1, 50, "Arbitrum", "B")],
    };
    mount([h]);
    openRow("Bitcoin");
    const rows = panelRows("Platforms");
    expect(rows[0]).toMatch(/95%$/);
    expect(rows[1]).toMatch(/5\.0%$/);
  });

  it("唯一账户与平台同名(严格相等)→ 省掉副行;大小写不同就照常显示", () => {
    const h: Holding = {
      ...btc,
      totalValue: 100,
      sources: [
        src("binance", "a", 1, 60, "Binance", "Binance"),
        src("okx", "b", 1, 40, "OKX", "okx"),
      ],
    };
    mount([h]);
    openRow("Bitcoin");
    const rows = panelRows("Platforms");
    expect(rows[0]).not.toContain("@");
    expect(rows[1]).toContain("@okx");
  });
});

describe("隐私", () => {
  it("开着 → 抽屉里的总数量与各来源数量被遮,占比留着", () => {
    mount([btc], { hide: true });
    act(() => {
      openRow("Bitcoin");
    });
    const panel = showPanel("Platforms");
    const masked = within(panel)
      .getAllByRole("button", { name: /balance hidden/i })
      .map((m) => m.textContent);
    expect(masked).toEqual(["0.06", "0.04"]);
    expect(within(panel).getByText("60%")).toBeTruthy();
  });
});
