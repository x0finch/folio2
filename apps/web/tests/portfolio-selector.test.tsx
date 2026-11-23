import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioSummary } from "@/lib/hooks/use-portfolio";
import { messages } from "@/lib/i18n/messages";

// Global Portfolio selector in the header. Hidden with a single portfolio; the URL is the source of
// truth for selection (usePortfolio), stubbed here since it reads route search.
const { portfolioState, select } = vi.hoisted(() => ({
  portfolioState: { portfolios: [] as PortfolioSummary[], selectedId: "", defaultId: "" },
  select: vi.fn(),
}));

vi.mock("@/lib/hooks/use-portfolio", () => ({
  usePortfolio: () => ({ ...portfolioState, select }),
}));
vi.mock("@/lib/server/portfolios", () => ({
  createPortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  moveAccountToPortfolio: vi.fn(),
  renamePortfolio: vi.fn(),
  setDefaultPortfolio: vi.fn(),
}));

const { PortfolioSelector } = await import("@/components/portfolio-selector");

const tp = messages.en.Portfolio;
const P = (id: string, name: string, isDefault = false): PortfolioSummary => ({
  id,
  name,
  isDefault,
});

function mount(portfolios: PortfolioSummary[], selectedId: string) {
  portfolioState.portfolios = portfolios;
  portfolioState.selectedId = selectedId;
  portfolioState.defaultId = portfolios.find((p) => p.isDefault)?.id ?? "";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <PortfolioSelector />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const trigger = () =>
    utils.container.querySelector(`button[aria-label="${tp.selectorLabel}"]`) as HTMLElement | null;
  // Hover popover: focusing the trigger opens it too (keyboard path).
  const openMenu = () => fireEvent.focus(trigger() as HTMLElement);
  const menuButton = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLElement;
  return { ...utils, trigger, openMenu, menuButton };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PortfolioSelector", () => {
  it("single portfolio -> renders nothing", () => {
    const { container } = mount([P("p1", "Main", true)], "p1");
    expect(container.innerHTML).toBe("");
  });

  it("two or more -> badge shows the selected portfolio name", () => {
    const { trigger } = mount([P("p1", "Main", true), P("p2", "Degen")], "p2");
    expect(trigger()?.textContent).toContain("Degen");
  });

  it("clicking a portfolio in the menu -> select(that id)", async () => {
    const { openMenu, menuButton } = mount([P("p1", "Main", true), P("p2", "Degen")], "p1");
    openMenu();
    await waitFor(() => expect(menuButton("Degen")).toBeTruthy());
    fireEvent.click(menuButton("Degen"));
    expect(select).toHaveBeenCalledWith("p2");
  });

  it("'Manage portfolios' -> opens the manage modal", async () => {
    const { openMenu, menuButton } = mount([P("p1", "Main", true), P("p2", "Degen")], "p1");
    expect(document.body.querySelector("h2")).toBeNull();
    openMenu();
    await waitFor(() => expect(menuButton(tp.manage)).toBeTruthy());
    fireEvent.click(menuButton(tp.manage));
    await waitFor(() =>
      expect(
        [...document.body.querySelectorAll("h2")].some((h) => h.textContent === tp.manageTitle),
      ).toBe(true),
    );
  });
});
