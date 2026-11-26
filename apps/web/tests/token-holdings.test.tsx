import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Holding, HoldingSource } from "@/lib/core/portfolio";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";
import { tabPanel } from "./helpers/tabs";

const { getTokenValueHistory } = vi.hoisted(() => ({
  getTokenValueHistory: vi.fn(),
}));
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory }));
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
afterEach(cleanup);

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

describe("list and small-holdings fold", () => {
  it("fewer than 10 holdings: fully expanded, small ones included, no fold control", () => {
    mount([coin(1, 500), coin(2, 0.2)]);
    expect(rowNames()).toEqual(["Token 1", "Token 2"]);
    expect(screen.queryByText(/small holdings/)).toBeNull();
  });

  it("10 or more holdings: < $1 collapsed; expands on click, collapses again", () => {
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

  it("row with current value 0 but a large P&L that day (fully sold token) is not folded into small holdings", () => {
    const soldOut: Holding = { ...coin(9, 0), sources: [], gain24h: { amount: -3000, pct: -100 } };
    mount([...Array.from({ length: 8 }, (_, i) => coin(i, 100 + i)), coin(8, 0.5), soldOut]);
    expect(rowNames()).toContain("Token 9");
    expect(rowNames()).not.toContain("Token 8");
  });

  it("10 or more but no small holdings: no fold control", () => {
    mount(Array.from({ length: 10 }, (_, i) => coin(i, 100)));
    expect(rowNames()).toHaveLength(10);
    expect(screen.queryByText(/small holdings/)).toBeNull();
  });
});

describe("token detail drawer", () => {
  it("closed before clicking; clicking a row opens that token and fetches history by its key with the default 30D window", async () => {
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

  it("switching to 7D: refetches with the 7d window", async () => {
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

  it("header: rank + unit price badge, total quantity, 24h P&L and percentage", () => {
    const { baseElement } = mount([btc]);
    openRow("Bitcoin");
    const head = sheetHeading().parentElement as HTMLElement;
    expect(head.textContent).toBe("Bitcoin#1$60,000.00");
    expect(baseElement.textContent).toContain("+$100.00 1.70%");
  });

  it("24h not computable: `—`; no rank or no unit price: no badge", () => {
    mount([{ ...btc, gain24h: null, token: { symbol: "BTC", name: "Bitcoin" } }]);
    openRow("Bitcoin");
    expect((sheetHeading().parentElement as HTMLElement).textContent).toBe("Bitcoin");
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  const chartDrawn = (c: HTMLElement) =>
    c.querySelector("[data-slot=sparkline]:not([aria-hidden])");

  it('history comes back empty: shows the "no data yet" line, draws no chart', async () => {
    const { baseElement } = mount([btc]);
    openRow("Bitcoin");
    await waitFor(() => expect(screen.getByText(/once it's ready/i)).toBeTruthy());
    expect(chartDrawn(baseElement)).toBeNull();
  });

  it('history comes back with two or more points: draws the chart, no "no data yet" line', async () => {
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
});

const showPanel = (name: "Platforms" | "Accounts") => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.click(tab);
  return tabPanel(tab);
};
const panelRows = (name: "Platforms" | "Accounts") =>
  [...showPanel(name).querySelectorAll(".rounded-xl.px-3")].map((r) => r.textContent);

describe("two source views", () => {
  it("by platform: platform name + `@account`, quantity and share, sorted by amount descending", () => {
    mount([btc]);
    openRow("Bitcoin");
    expect(panelRows("Platforms")).toEqual([
      "BBinance@Main0.06 BTC60%",
      "BBitcoin@Cold0.04 BTC40%",
    ]);
  });

  it("by account: `@account` on the main row, platform name on the sub row", () => {
    mount([btc]);
    openRow("Bitcoin");
    expect(panelRows("Accounts")).toEqual(["B@MainBinance0.06 BTC60%", "B@ColdBitcoin0.04 BTC40%"]);
  });

  it('more than 3 accounts under one platform: names the first 2 + `+n`; account spanning several places: sub row "N sources"', () => {
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
});

describe("privacy", () => {
  it("on: total quantity and per-source quantities in the drawer are masked, shares remain", () => {
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
