import type { AccountTagLink } from "@folio/db";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import type { AccountHoldings, AccountListItem } from "@/lib/queries/accounts";
import { accountKeys, tagKeys } from "@/lib/queries/keys";

// 账户页名单(不含抽屉 / 加账户弹窗本身 —— 它们各有自己的测试文件,这里换成替身,只看这页
// 递给它们的是什么)。钉住的用户可见行为:
// ① 名单:活跃账户按市值从大到小、标题数的是活跃数;归档的收进折叠段;一个都没有时给空态;
// ② 金额没到时别把市值写成 0 —— 名单照出,金额位是骨架,也别按假 0 排序;
// ③ 每行的状态句:缺凭据 → 可点的「补凭据」(点它进补录、不打开抽屉);手记 → 「实时」;
//    从没同步 → 「从未同步」;
// ④ 点一行打开那个账户的抽屉;页头 + 段打开加账户弹窗;
// ⑤ 同步面板跨页带来的 `?focus=<id>`:滚到那一行,然后从地址上抹掉(一次性命令)。
const { navigate, routeSearch, holdingsView } = vi.hoisted(() => ({
  navigate: vi.fn(),
  routeSearch: { current: {} as { focus?: string } },
  holdingsView: { current: (): unknown => undefined },
}));

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  getRouteApi: () => ({
    useSearch: () => routeSearch.current,
    useNavigate: () => navigate,
  }),
}));
vi.mock("@/lib/hooks/use-portfolio", () => ({ usePortfolio: () => ({ selectedId: "p1" }) }));
// 金额那一层:由用例决定「已到」(返回视图)还是「在路上」(挂起)。
vi.mock("@/lib/queries/account-holdings-compose", () => ({
  useAccountHoldingsView: () => holdingsView.current(),
}));
vi.mock("@/routes/_authed/-home/header-sync", () => ({
  HeaderSync: ({ action }: { action: { label: string; onClick: () => void } }) => (
    <button type="button" onClick={action.onClick}>
      {action.label}
    </button>
  ),
}));
vi.mock("@/routes/_authed/-accounts/account-detail-sheet", () => ({
  AccountDetailSheet: ({
    account,
    open,
    onOpenChange,
  }: {
    account: { label: string } | null;
    open: boolean;
    onOpenChange: (o: boolean) => void;
  }) =>
    open ? (
      <div data-testid="sheet">
        {account?.label}
        <button type="button" onClick={() => onOpenChange(false)}>
          close-sheet
        </button>
      </div>
    ) : null,
}));
vi.mock("@/routes/_authed/-accounts/add-account-modal", () => ({
  AddAccountModal: ({
    open,
    completeFor,
  }: {
    open: boolean;
    completeFor: { accountId: string; connectorId: string; credsSafe: object } | null;
  }) => (
    <div data-testid="add-modal">
      {open ? "add-open" : "add-closed"}
      {completeFor ? ` complete:${JSON.stringify(completeFor)}` : ""}
    </div>
  ),
}));
// 种了缓存的查询不会去拉;这几条只是挡住 server fn 模块在 jsdom 里加载。
const never = () => new Promise(() => {});
vi.mock("@/lib/server/accounts", () => ({
  listAccounts: vi.fn(never),
  getAccountHistory: vi.fn(never),
}));
vi.mock("@/lib/server/tags", () => ({ listTags: vi.fn(never), listAccountTags: vi.fn(never) }));
vi.mock("@/lib/server/preferences", () => ({ getCurrencyPreference: vi.fn(never) }));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors: vi.fn(never),
  getConnectorCredentialSpecs: vi.fn(never),
}));
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory: vi.fn(never) }));
vi.mock("@/lib/server/manual-tokens", () => ({ getManualAccount: vi.fn(never) }));
vi.mock("@/lib/server/portfolio", () => ({ getSnapshots: vi.fn(never) }));

const { Accounts } = await import("@/routes/_authed/-accounts");

const HOUR = 3_600_000;
const NOW = Date.now();

const acct = (over: Partial<AccountListItem> & { id: string; label: string }): AccountListItem =>
  ({
    connectorId: "evm",
    archivedAt: null,
    needsCredentials: false,
    credsSafe: {},
    portfolioId: "p1",
    ...over,
  }) as AccountListItem;

const holdingRow = (id: string, totalUsd: number, takenAt: number | null = NOW - HOUR) => ({
  account: { id },
  totalUsd,
  takenAt,
  balances: [],
  gain24h: null,
});

function mount(accounts: AccountListItem[], tagLinks: AccountTagLink[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(accountKeys.list("p1"), accounts);
  client.setQueryData(tagKeys.list("p1"), [{ id: "t1", name: "cold", portfolioId: "p1" }]);
  client.setQueryData(tagKeys.accountLinks("p1"), tagLinks);
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(NOW)}>
        <Accounts />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// 一行就是一个 <button>(整行可点开抽屉)。
const rowButton = (label: string) => screen.getByText(label).closest("button") as HTMLButtonElement;

// jsdom 的元素没有 scrollIntoView → 记下被滚到的是哪一行。
let scrolled: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  routeSearch.current = {};
  holdingsView.current = () => ({ rows: [] }) satisfies AccountHoldings;
});

describe("名单", () => {
  it("活跃账户按市值从大到小排,标题数的是活跃数", async () => {
    holdingsView.current = () => ({
      rows: [holdingRow("a", 100), holdingRow("b", 5_000), holdingRow("c", 900)],
    });
    mount([
      acct({ id: "a", label: "Small" }),
      acct({ id: "b", label: "Big" }),
      acct({ id: "c", label: "Mid" }),
    ]);

    await screen.findByText("3 accounts");
    const order = ["Small", "Big", "Mid"]
      .map((l) => ({ l, top: [...document.querySelectorAll("button")].indexOf(rowButton(l)) }))
      .sort((x, y) => x.top - y.top)
      .map((x) => x.l);
    expect(order).toEqual(["Big", "Mid", "Small"]);
  });

  it("归档账户不算进标题,收进「已归档」折叠段", async () => {
    mount([
      acct({ id: "a", label: "Live one" }),
      acct({ id: "z", label: "Old one", archivedAt: Date.UTC(2025, 0, 2) }),
    ]);

    await screen.findByText("1 account");
    const archived = screen.getByText("Archived (1)").closest("details") as HTMLElement;
    expect(within(archived).getByText("Old one")).toBeTruthy();
    expect(within(archived).queryByText("Live one")).toBeNull();
    // 封存那一行写的是静态日期,不是相对时间。
    expect(within(archived).getByText("Sealed Jan 2, 25")).toBeTruthy();
  });

  it("一个账户都没有 → 空态", async () => {
    mount([]);
    await screen.findByText("No accounts yet.");
    expect(screen.getByText("0 accounts")).toBeTruthy();
  });

  it("金额没到 → 名单照出、按原顺序,市值位不写 0", async () => {
    holdingsView.current = () => {
      throw new Promise(() => {}); // 挂起:金额还在路上
    };
    mount([acct({ id: "a", label: "First" }), acct({ id: "b", label: "Second" })]);

    await screen.findByText("2 accounts");
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("金额没到 → 名单里已能确定的状态句(缺凭据 / 手记 / 封存日)照样立刻写出", async () => {
    holdingsView.current = () => {
      throw new Promise(() => {}); // 挂起:金额还在路上
    };
    mount([
      acct({ id: "x", label: "My CEX", connectorId: "binance", needsCredentials: true }),
      acct({ id: "m", label: "Cash", connectorId: "manual" }),
      acct({ id: "z", label: "Old one", archivedAt: Date.UTC(2025, 0, 2) }),
    ]);

    await screen.findByText("2 accounts");
    expect(within(rowButton("My CEX")).getByText("Click to add credentials")).toBeTruthy();
    expect(within(rowButton("Cash")).getByText("Live")).toBeTruthy();
    expect(within(rowButton("Old one")).getByText("Sealed Jan 2, 25")).toBeTruthy();
  });
});

describe("行内状态句", () => {
  it("手记账户 → 「实时」;从没同步 → 「从未同步」", async () => {
    holdingsView.current = () => ({
      rows: [holdingRow("m", 10, null), holdingRow("n", 20, null)],
    });
    mount([
      acct({ id: "m", label: "Cash", connectorId: "manual" }),
      acct({ id: "n", label: "Fresh wallet" }),
    ]);

    await screen.findByText("2 accounts");
    expect(within(rowButton("Cash")).getByText("Live")).toBeTruthy();
    expect(within(rowButton("Fresh wallet")).getByText("Never synced")).toBeTruthy();
  });

  it("缺凭据 → 点「补凭据」把这个账户交给补录弹窗,且不打开抽屉", async () => {
    mount([
      acct({
        id: "x",
        label: "Binance",
        connectorId: "binance",
        needsCredentials: true,
        credsSafe: { apiKey: "ab…yz" },
      }),
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Click to add credentials" }));

    expect(screen.getByTestId("add-modal").textContent).toContain(
      `complete:${JSON.stringify({ accountId: "x", connectorId: "binance", credsSafe: { apiKey: "ab…yz" } })}`,
    );
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("缺凭据 → 键盘在「补凭据」上按 Enter 也进补录,且不打开抽屉", async () => {
    mount([
      acct({
        id: "x",
        label: "Binance",
        connectorId: "binance",
        needsCredentials: true,
      }),
    ]);

    fireEvent.keyDown(await screen.findByRole("button", { name: "Click to add credentials" }), {
      key: "Enter",
    });

    expect(screen.getByTestId("add-modal").textContent).toContain('complete:{"accountId":"x"');
    expect(screen.queryByTestId("sheet")).toBeNull();
  });
});

describe("打开抽屉与弹窗", () => {
  it("点一行 → 抽屉打开的是这个账户;关掉就收起", async () => {
    mount([acct({ id: "a", label: "Alpha" }), acct({ id: "b", label: "Beta" })]);

    await screen.findByText("Beta");
    fireEvent.click(rowButton("Beta"));
    expect(within(screen.getByTestId("sheet")).getByText("Beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "close-sheet" }));
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("点归档段里的一行 → 也打开那个账户的抽屉", async () => {
    mount([
      acct({ id: "a", label: "Alpha" }),
      acct({ id: "z", label: "Old one", archivedAt: Date.UTC(2025, 0, 2) }),
    ]);

    await screen.findByText("Old one");
    fireEvent.click(rowButton("Old one"));
    expect(within(screen.getByTestId("sheet")).getByText("Old one")).toBeTruthy();
  });

  it("页头 + 段 → 打开加账户弹窗", async () => {
    mount([acct({ id: "a", label: "Alpha" })]);
    expect(screen.getByTestId("add-modal").textContent).toContain("add-closed");

    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(screen.getByTestId("add-modal").textContent).toContain("add-open");
  });
});

describe("?focus=<id> 一次性命令", () => {
  it("滚到那一行,然后从地址上抹掉 focus(replace,不动滚动)", async () => {
    routeSearch.current = { focus: "b" };
    mount([acct({ id: "a", label: "Alpha" }), acct({ id: "b", label: "Beta" })]);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(scrolled).toEqual(["account-row-b"]);
    const arg = navigate.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ replace: true, resetScroll: false });
    expect(arg.search({ focus: "b", portfolio: "p9" })).toEqual({
      focus: undefined,
      portfolio: "p9",
    });
  });

  it("那一行已不在名单里 → 不滚,但照样抹掉 focus", async () => {
    routeSearch.current = { focus: "gone" };
    mount([acct({ id: "a", label: "Alpha" })]);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(scrolled).toEqual([]);
  });
});
