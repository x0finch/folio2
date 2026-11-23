import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPoint, PortfolioHistoryRaw } from "@/lib/core/history";
import type { Holding } from "@/lib/core/portfolio";
import { messages } from "@/lib/i18n/messages";
import type { PortfolioOverview } from "@/lib/queries/portfolio";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

const h = vi.hoisted(() => ({
  history: vi.fn<(id: string, range: string) => Promise<PortfolioHistoryRaw>>(),
  overview: vi.fn<() => PortfolioOverview>(),
  chartSeries: [] as HistoryPoint[][],
}));

vi.mock("@/lib/hooks/use-portfolio", () => ({ usePortfolio: () => ({ selectedId: "p1" }) }));
vi.mock("@/lib/queries/portfolio", () => ({
  portfolioHistoryQuery: (id: string, range: string) =>
    queryOptions({ queryKey: ["history", id, range], queryFn: () => h.history(id, range) }),
}));
vi.mock("@/lib/queries/portfolio-overview-compose", () => ({
  usePortfolioOverview: () => h.overview(),
}));
vi.mock("@/routes/_authed/-home/header-sync", () => ({ HeaderSync: () => null }));
vi.mock("@/routes/_authed/-insights/portfolio-chart", () => ({
  PortfolioChart: ({ series }: { series: HistoryPoint[] }) => {
    h.chartSeries.push(series);
    return <div data-testid="chart">{series.length} points</div>;
  },
}));

const { Insights } = await import("@/routes/_authed/-insights");

const holding = (
  key: string,
  symbol: string,
  value: number,
  platform: { id: string; name: string },
  account: { id: string; label: string },
): Holding => ({
  key,
  token: { symbol, name: symbol },
  totalValue: value,
  gain24h: null,
  sources: [{ platform, account, amount: 1, value, kind: "spot" }],
});

const eth = { id: "ethereum", name: "Ethereum" };
const cex = { id: "binance", name: "Binance" };
const cold = { id: "a1", label: "Cold" };
const hot = { id: "a2", label: "Hot" };

const overview = (): PortfolioOverview => ({
  holdings: [
    holding("btc", "BTC", 600, cex, hot),
    holding("eth", "ETH", 300, eth, cold),
    holding("usdc", "USDC", 100, eth, hot),
  ],
  sections: [],
  accountTotals: [{ account: cold, totalUsd: 200, takenAt: null }],
  totalUsd: 1_000,
  holdingsSubtotal: 1_000,
  defiSubtotal: 0,
  pending: false,
});

const raw = (over: Partial<PortfolioHistoryRaw> = {}): PortfolioHistoryRaw => ({
  rows: [
    { accountId: "a1", takenAt: T0, totalUsd: 100 },
    { accountId: "a1", takenAt: T0 + 3_600_000, totalUsd: 120 },
    { accountId: "a1", takenAt: T0 + 2 * DAY, totalUsd: 150 },
  ],
  archivedAt: [],
  liveAccountIds: ["a1"],
  ...over,
});

beforeEach(() => {
  h.history.mockReset();
  h.history.mockImplementation(async () => raw());
  h.overview.mockReset();
  h.overview.mockImplementation(overview);
  h.chartSeries = [];
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <Insights />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const lastSeries = () => h.chartSeries.at(-1) ?? [];

describe("trend card", () => {
  it('fetches the current portfolio history with the "All" window', async () => {
    mount();
    await screen.findByTestId("chart");
    expect(h.history).toHaveBeenCalledWith("p1", "all");
    expect(screen.getByText("Portfolio value")).toBeTruthy();
  });

  it("history still loading: skeleton, no chart", () => {
    h.history.mockImplementation(() => new Promise(() => {}));
    const { container } = mount();
    expect(screen.queryByTestId("chart")).toBeNull();
    expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("unsampled (short window): aggregated by day, last point replaced with the live overview value", async () => {
    mount();
    await screen.findByTestId("chart");
    const s = lastSeries();
    expect(s).toHaveLength(2);
    expect(s.at(-1)?.total).toBe(200);
  });

  it("sampled (long window): not aggregated by day, every sample point is kept", async () => {
    h.history.mockImplementation(async () => raw({ sampled: true }));
    mount();
    await screen.findByTestId("chart");
    expect(lastSeries()).toHaveLength(3);
    expect(lastSeries().at(-1)?.total).toBe(200);
  });

  it('fewer than two points: "No data yet.", no chart', async () => {
    h.history.mockImplementation(async () =>
      raw({ rows: [{ accountId: "a1", takenAt: T0, totalUsd: 100 }] }),
    );
    mount();
    await waitFor(() => expect(screen.getAllByText("No data yet.").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("chart")).toBeNull();
  });
});

const legend = () => [...document.querySelectorAll("li")].map((li) => li.textContent);

describe("distribution card", () => {
  it("split by token by default, sorted by amount descending", () => {
    mount();
    expect(screen.getByText("Allocation")).toBeTruthy();
    expect(legend()).toEqual(["BTC60%$600.00", "ETH30%$300.00", "USDC10%$100.00"]);
  });

  it("switch to by chain: legend uses platform names; by account: account names", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "By chain" }));
    expect(legend()).toEqual(["Binance60%$600.00", "Ethereum40%$400.00"]);
    fireEvent.click(screen.getByRole("tab", { name: "By account" }));
    expect(legend()).toEqual(["Hot70%$700.00", "Cold30%$300.00"]);
  });
});
