import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeTabStripView } from "@/lib/core/portfolio";
import { messages } from "@/lib/i18n/messages";

// Home assembly: each of the three islands has its own suspense / error boundary; the shell (sync bar)
// never collapses with them. Islands, sync bar and router Link are stubbed.

const h = vi.hoisted(() => ({
  strip: { hasAccounts: true, hasPerps: false, hasDefi: false, pins: [] } as HomeTabStripView,
  hero: { current: (): ReactNode => "HERO" },
  holdings: { current: (): ReactNode => "HOLDINGS" },
  headerSyncProps: [] as unknown[],
  linkProps: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: (p: { to: string; params: unknown; children: ReactNode }) => {
    h.linkProps.push({ to: p.to, params: p.params });
    return <a href="#accounts">{p.children}</a>;
  },
}));
vi.mock("@/lib/hooks/use-portfolio", () => ({ usePortfolio: () => ({ selectedId: "p1" }) }));
vi.mock("@/lib/hooks/use-home-tab-strip", () => ({ useHomeTabStrip: () => h.strip }));
vi.mock("@/routes/_authed/-home/header-sync", () => ({
  HeaderSync: (props: unknown) => {
    h.headerSyncProps.push(props);
    return <div>SYNC</div>;
  },
}));
vi.mock("@/routes/_authed/-home/hero", () => ({ HeroIsland: () => <>{h.hero.current()}</> }));
vi.mock("@/routes/_authed/-home/holdings", () => ({
  HoldingsIsland: () => <>{h.holdings.current()}</>,
}));
vi.mock("@/routes/_authed/-home/tab", async () => {
  const { useHomeViewState } = await import("@/routes/_authed/-home/view-state");
  return {
    // Reads view state: throws if the Provider isn't mounted at this layer.
    TabStripIsland: () => <>TABS:{useHomeViewState().tab}</>,
  };
});

const { Overview } = await import("@/routes/_authed/-home");

beforeEach(() => {
  h.strip = { hasAccounts: true, hasPerps: false, hasDefi: false, pins: [] };
  h.hero.current = () => "HERO";
  h.holdings.current = () => "HOLDINGS";
  h.headerSyncProps = [];
  h.linkProps = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  return render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
      <Overview />
    </IntlProvider>,
  );
}

describe("home assembly", () => {
  it("with accounts → sync bar + hero + tab strip + holdings; home enables auto-sync when stale", () => {
    const { container } = mount();
    expect(container.textContent).toBe("SYNCHEROTABS:tokensHOLDINGS");
    expect(h.headerSyncProps.at(-1)).toEqual({ autoSyncWhenStale: true });
  });

  it("no accounts → the tab strip slot becomes 'No accounts yet. Add one.', linking to accounts", () => {
    h.strip = { ...h.strip, hasAccounts: false };
    mount();
    expect(screen.queryByText(/TABS/)).toBeNull();
    expect(screen.getByText(/No accounts yet\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add one" })).toBeTruthy();
    expect(h.linkProps.at(-1)).toEqual({ to: "/{-$page}", params: { page: "accounts" } });
  });

  it("an island still loading → only that slot is a skeleton, others normal", () => {
    h.hero.current = () => {
      throw new Promise(() => {});
    };
    const { container } = mount();
    expect(container.textContent).toBe("SYNCTABS:tokensHOLDINGS");
    expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy();
  });

  it("holdings island loading → skeleton rows; hero and tab strip unaffected", () => {
    h.holdings.current = () => {
      throw new Promise(() => {});
    };
    const { container } = mount();
    expect(container.textContent).toBe("SYNCHEROTABS:tokens");
    expect(container.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(1);
  });

  it("an island fails → only that slot says 'Couldn't load this.'; sync bar and other islands stay", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.holdings.current = () => {
      throw new Error("boom");
    };
    const { container } = mount();
    expect(screen.getByText("Couldn't load this.")).toBeTruthy();
    expect(container.textContent).toContain("SYNCHEROTABS:tokens");
  });

  it("hero fails → that slot says 'Couldn't load this.'; tab strip and holdings normal", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.hero.current = () => {
      throw new Error("boom");
    };
    const { container } = mount();
    expect(container.textContent).toBe("SYNCCouldn't load this.TABS:tokensHOLDINGS");
  });
});
