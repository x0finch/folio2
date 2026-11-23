import { toast } from "@folio/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTabStripView } from "@/lib/core/portfolio";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { messages } from "@/lib/i18n/messages";
import type { PinScopeKey } from "@/lib/queries/keys";
import type { PortfolioOverview } from "@/lib/queries/portfolio";
import { tabLabel } from "./helpers/tabs";

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

const tabNames = () => screen.getAllByRole("tab").map(tabLabel);
const selectedTab = () =>
  tabLabel(
    screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true") as Element,
  );
const tab = (name: string) => screen.getByRole("tab", { name });
const total = (container: HTMLElement) =>
  (container.querySelector("[role=tablist]")?.closest(".flex.items-center.gap-4") as HTMLElement)
    .lastElementChild as HTMLElement;
const addButton = () => screen.queryByRole("button", { name: "Pin a view" });
const unpinButton = () => screen.queryByRole("button", { name: "Unpin" });

describe("tab strip", () => {
  it("Tokens always shown; Perps / DeFi follow the portfolio; pins carry a #/@ prefix", () => {
    h.strip.current = { ...h.strip.current, pins: [tagPin, acctPin] };
    mount();
    expect(tabNames()).toEqual(["Tokens", "Perps", "DeFi", "#DeFi", "@Cold"]);
  });

  it("no perps / DeFi in the portfolio: only Tokens remain", () => {
    h.strip.current = { ...h.strip.current, hasPerps: false, hasDefi: false };
    mount();
    expect(tabNames()).toEqual(["Tokens"]);
  });

  it("Tokens selected by default; clicking another tab selects it", () => {
    mount();
    expect(selectedTab()).toBe("Tokens");
    fireEvent.click(tab("Perps"));
    expect(selectedTab()).toBe("Perps");
    expect(currentTab).toBe("perps");
  });
});

describe("right-hand total", () => {
  it("follows the view tab: spot / perp equity / DeFi subtotal", () => {
    const { container } = mount();
    expect(total(container).textContent).toBe("$1,500.00");
    fireEvent.click(tab("Perps"));
    expect(total(container).textContent).toBe("$300.00");
    fireEvent.click(tab("DeFi"));
    expect(total(container).textContent).toBe("$15.00");
  });

  it("selected pin: fetches a separate overview for its target and shows that total", () => {
    h.strip.current = { ...h.strip.current, pins: [tagPin] };
    const { container } = mount();
    fireEvent.click(tab("#DeFi"));
    expect(h.overview).toHaveBeenCalledWith("p1", { kind: "tag", tagId: "t1" });
    expect(total(container).textContent).toBe("$42.00");
  });

  it("pin overview still loading: skeleton, never the unnarrowed full total", () => {
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

  it("total fetch fails: `—`", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.overview.mockImplementation(() => {
      throw new Error("boom");
    });
    const { container } = mount();
    expect(total(container).textContent).toBe("—");
  });

  it("privacy on: total is masked", () => {
    const { container } = mount({ hide: true });
    expect(
      within(total(container)).getByRole("button", { name: /balance hidden/i }).textContent,
    ).toBe("$1,500.00");
  });
});

describe("+ pin a view", () => {
  it("3 pins already: + is hidden", () => {
    h.strip.current = {
      ...h.strip.current,
      pins: [tagPin, acctPin, { id: "pin3", kind: "connector", connectorId: "okx", name: "OKX" }],
    };
    mount();
    expect(addButton()).toBeNull();
  });

  it("click +: picker lists only active accounts of the current portfolio, connectors deduped, archived hidden", async () => {
    mount();
    expect(screen.queryByText("Tags")).toBeNull();
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

  it("pick one: createTabPin; selects the new tab once it appears on the strip", async () => {
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

  it("refreshed strip lacks the new tab: waits, selects only once it really appears", async () => {
    const before = h.strip.current;
    h.createTabPin.mockResolvedValue(acctPin);
    h.fetchHomeTabStrip
      .mockImplementationOnce(async () => before)
      .mockImplementation(async () => ({ ...before, pins: [acctPin] }));
    mount();
    fireEvent.click(addButton() as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "@Cold" }));
    await waitFor(() => expect(h.fetchHomeTabStrip).toHaveBeenCalledTimes(1));
    expect(currentTab).toBe("tokens");
    await waitFor(() => expect(currentTab).toBe("pin2"), { timeout: 5_000 });
    expect(h.fetchHomeTabStrip).toHaveBeenCalledTimes(2);
  });

  it("create fails: toast error, tab not switched", async () => {
    const err = vi.spyOn(toast, "error").mockImplementation(() => "");
    h.createTabPin.mockRejectedValue(new Error("cap"));
    mount();
    fireEvent.click(addButton() as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "#DeFi" }));
    await waitFor(() => expect(err).toHaveBeenCalledWith("Something went wrong."));
    expect(currentTab).toBe("tokens");
  });

  it("picker data fails to load: panel says so instead of staying blank", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.listTags.mockRejectedValue(new Error("down"));
    mount();
    fireEvent.click(addButton() as HTMLElement);
    expect(await screen.findByText("Something went wrong.")).toBeTruthy();
  });
});

describe("pin management panel", () => {
  beforeEach(() => {
    h.strip.current = { ...h.strip.current, pins: [tagPin, acctPin] };
  });

  it("unselected pin: first click only selects, second opens the panel", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    expect(selectedTab()).toBe("#DeFi");
    expect(unpinButton()).toBeNull();
    fireEvent.click(tab("#DeFi"));
    expect(await screen.findByRole("button", { name: "Unpin" })).toBeTruthy();
  });

  it("click again while open: closes", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    await screen.findByRole("button", { name: "Unpin" });
    fireEvent.click(tab("#DeFi"));
    await waitFor(() => expect(unpinButton()).toBeNull());
  });

  it("retarget: updateTabPinTarget with pin id and new target; panel closes", async () => {
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

  it("unpin the selected one: deleteTabPin, selection moves to the left neighbour pin", async () => {
    mount();
    fireEvent.click(tab("@Cold"));
    fireEvent.click(tab("@Cold"));
    fireEvent.click(await screen.findByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(h.deleteTabPin).toHaveBeenCalledWith({ data: { pinId: "pin2" } }));
    expect(currentTab).toBe("pin1");
  });

  it("leftmost pin unpinned: selection falls to the last view tab", async () => {
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(await screen.findByRole("button", { name: "Unpin" }));
    expect(currentTab).toBe("defi");
  });

  it("delete fails: toast error", async () => {
    const err = vi.spyOn(toast, "error").mockImplementation(() => "");
    h.deleteTabPin.mockRejectedValue(new Error("x"));
    mount();
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(tab("#DeFi"));
    fireEvent.click(await screen.findByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(err).toHaveBeenCalledWith("Something went wrong."));
  });

  it("Esc / click outside the panel: closes", async () => {
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
});
