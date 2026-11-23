import type { AccountTagLink } from "@folio/db";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import type { AccountHoldings, AccountListItem } from "@/lib/queries/accounts";
import { accountKeys, tagKeys } from "@/lib/queries/keys";

// Accounts page list. The sheet and add-account modal have their own tests and are stubbed here;
// we check what the page hands them.
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
// Values layer: each test decides "arrived" (returns a view) or "in flight" (suspends).
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
// Seeded queries never fetch; these only keep server fn modules from loading in jsdom.
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

// Each row is a <button> (the whole row opens the sheet).
const rowButton = (label: string) => screen.getByText(label).closest("button") as HTMLButtonElement;

// jsdom elements lack scrollIntoView → record which row was scrolled to.
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

describe("list", () => {
  it("active accounts sorted by value descending; heading counts active accounts", async () => {
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

  it("archived accounts excluded from the heading count, collapsed into the archived section", async () => {
    mount([
      acct({ id: "a", label: "Live one" }),
      acct({ id: "z", label: "Old one", archivedAt: Date.UTC(2025, 0, 2) }),
    ]);

    await screen.findByText("1 account");
    const archived = screen.getByText("Archived (1)").closest("details") as HTMLElement;
    expect(within(archived).getByText("Old one")).toBeTruthy();
    expect(within(archived).queryByText("Live one")).toBeNull();
    // Archived rows show a static date, not relative time.
    expect(within(archived).getByText("Sealed Jan 2, 25")).toBeTruthy();
  });

  it("no accounts → empty state", async () => {
    mount([]);
    await screen.findByText("No accounts yet.");
    expect(screen.getByText("0 accounts")).toBeTruthy();
  });

  it("values not loaded → list renders in original order, value slot not 0", async () => {
    holdingsView.current = () => {
      throw new Promise(() => {}); // suspend: values in flight
    };
    mount([acct({ id: "a", label: "First" }), acct({ id: "b", label: "Second" })]);

    await screen.findByText("2 accounts");
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("values not loaded → statuses already known (missing creds / manual / archive date) render immediately", async () => {
    holdingsView.current = () => {
      throw new Promise(() => {}); // suspend: values in flight
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

describe("row status line", () => {
  it("manual account → 'live'; never synced → 'never synced'", async () => {
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

  it("missing creds → clicking 'add credentials' hands the account to the creds modal, sheet stays closed", async () => {
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

  it("missing creds → Enter on 'add credentials' also opens the creds modal, sheet stays closed", async () => {
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

describe("opening the sheet and modals", () => {
  it("clicking a row opens the sheet for that account; closing hides it", async () => {
    mount([acct({ id: "a", label: "Alpha" }), acct({ id: "b", label: "Beta" })]);

    await screen.findByText("Beta");
    fireEvent.click(rowButton("Beta"));
    expect(within(screen.getByTestId("sheet")).getByText("Beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "close-sheet" }));
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("clicking a row in the archived section also opens that account's sheet", async () => {
    mount([
      acct({ id: "a", label: "Alpha" }),
      acct({ id: "z", label: "Old one", archivedAt: Date.UTC(2025, 0, 2) }),
    ]);

    await screen.findByText("Old one");
    fireEvent.click(rowButton("Old one"));
    expect(within(screen.getByTestId("sheet")).getByText("Old one")).toBeTruthy();
  });

  it("header + button → opens the add-account modal", async () => {
    mount([acct({ id: "a", label: "Alpha" })]);
    expect(screen.getByTestId("add-modal").textContent).toContain("add-closed");

    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(screen.getByTestId("add-modal").textContent).toContain("add-open");
  });
});

describe("?focus=<id> one-shot command", () => {
  it("scrolls to that row, then strips focus from the URL (replace, no scroll reset)", async () => {
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

  it("row no longer in the list → no scroll, but focus is still stripped", async () => {
    routeSearch.current = { focus: "gone" };
    mount([acct({ id: "a", label: "Alpha" })]);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(scrolled).toEqual([]);
  });
});
