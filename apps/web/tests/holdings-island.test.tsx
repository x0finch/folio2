import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTabStripView } from "@/lib/core/portfolio";
import { messages } from "@/lib/i18n/messages";
import type { PinScopeKey } from "@/lib/queries/keys";
import type { PortfolioOverview } from "@/lib/queries/portfolio";

// Home holdings island: what renders for the selected tab. Data hooks (portfolio selection, tab strip,
// overview) are stubbed; this only checks the branching at this layer.

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
// The token sheet's history module imports these server fn modules; just block loading them.
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
      // Empty perp shell (no positions, no equity) → must not take a block in the perps tab
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

// Test tab switcher: writes the home tab state directly (the tab strip does this in the app).
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

describe("view tabs", () => {
  it("no accounts → renders nothing", () => {
    h.strip.current = { ...h.strip.current, hasAccounts: false };
    const { container } = mount();
    expect(container.textContent).toBe("");
  });

  it("default tokens → token list", () => {
    mount();
    expect(screen.getByText("Bitcoin")).toBeTruthy();
  });

  it("tokens with no holdings → 'No snapshot yet'", () => {
    h.overview.mockImplementation(() => overview({ holdings: [] }));
    mount();
    expect(screen.getByText(/No snapshot yet/)).toBeTruthy();
  });

  it("perps → only accounts with actual equity / positions", () => {
    const { go } = mount();
    go("perps");
    expect(screen.getByText("Hyperliquid")).toBeTruthy();
    expect(screen.queryByText("Wallet 2")).toBeNull();
    expect(screen.queryByText("Bitcoin")).toBeNull();
  });

  it("defi → merged by protocol across accounts into one row, no section header", () => {
    const { go, container } = mount();
    go("defi");
    expect(screen.getAllByText("Aave", { selector: ".truncate" })).toHaveLength(1);
    expect(container.textContent).toContain("$15.00"); // 10 + 5 merged
    expect(screen.queryByText("DeFi positions")).toBeNull();
  });

  it("unknown tab value (e.g. a deleted pin) → falls back to tokens", () => {
    const { go } = mount();
    go("pin-that-is-gone");
    expect(screen.getByText("Bitcoin")).toBeTruthy();
  });

  it("perps selected but the portfolio has no perps anymore → falls back to tokens, not blank", () => {
    h.strip.current = { ...h.strip.current, hasPerps: false };
    const { go } = mount();
    go("perps");
    expect(screen.getByText("Bitcoin")).toBeTruthy();
    expect(screen.queryByText("Hyperliquid")).toBeNull();
  });

  it("view tabs fetch only the portfolio overview, without pin scope", () => {
    mount();
    expect(h.overview).toHaveBeenCalledWith("p1", undefined);
    expect(h.overview.mock.calls.every(([, pin]) => pin === undefined)).toBe(true);
  });
});

describe("custom tabs (pins)", () => {
  beforeEach(() => {
    h.strip.current = {
      ...h.strip.current,
      pins: [{ id: "pin1", kind: "tag", tagId: "t1", name: "DeFi" }],
    };
  });

  it("fetches a separate overview for the pin's target", () => {
    const { go } = mount();
    go("pin1");
    expect(h.overview).toHaveBeenCalledWith("p1", { kind: "tag", tagId: "t1" });
  });

  it("that overview is empty → 'No accounts match this tab yet.'", () => {
    h.overview.mockImplementation((_id, pin) =>
      pin ? overview({ holdings: [], sections: [] }) : overview(),
    );
    const { go } = mount();
    go("pin1");
    expect(screen.getByText("No accounts match this tab yet.")).toBeTruthy();
  });

  it("with content → three sections by subtotal (largest omits its header), content from the pin's overview", () => {
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
    // Perps 300 > tokens 50 > DeFi 15: the largest (perps) omits its header, the other two show theirs.
    expect(screen.queryByText("Perps")).toBeNull();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.getByText("DeFi")).toBeTruthy();
  });

  it("pin overview still loading → skeleton, no flash of the full portfolio list", () => {
    h.overview.mockImplementation((_id, pin) => {
      if (pin) throw new Promise(() => {});
      return overview();
    });
    const { go, container } = mount();
    go("pin1");
    expect(screen.queryByText("Bitcoin")).toBeNull();
    expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("pin overview failed → 'Something went wrong.', page doesn't collapse", () => {
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
  it("perp equity subtotal = sum of equity of accounts with perps; empty perp shells don't count", () => {
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
