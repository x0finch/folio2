import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioSummary } from "@/lib/hooks/use-portfolio";
import { messages } from "@/lib/i18n/messages";

// 页头的全局 Portfolio 选择器(ADR 0033)。钉住:
// ① 渐进式显示 —— 只有一个组合时整个不渲染(和没有这个功能时一模一样);
// ② 徽标显示当前选中的组合名;
// ③ 点菜单里的组合 → 调 select(id)(选中态的事实源是 URL,由 usePortfolio 负责);
// ④ 「管理组合」→ 打开管理弹窗。
// usePortfolio 打桩:真实实现读路由 search,这里只关心选择器怎么用它。
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
  // hover 弹层:聚焦触发器同样会打开(键盘可达那条路径)。
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
  it("只有一个组合 → 不渲染", () => {
    const { container } = mount([P("p1", "Main", true)], "p1");
    expect(container.innerHTML).toBe("");
  });

  it("≥2 个 → 徽标显示当前选中的组合名", () => {
    const { trigger } = mount([P("p1", "Main", true), P("p2", "Degen")], "p2");
    expect(trigger()?.textContent).toContain("Degen");
  });

  it("点菜单里的组合 → select(该 id)", async () => {
    const { openMenu, menuButton } = mount([P("p1", "Main", true), P("p2", "Degen")], "p1");
    openMenu();
    await waitFor(() => expect(menuButton("Degen")).toBeTruthy());
    fireEvent.click(menuButton("Degen"));
    expect(select).toHaveBeenCalledWith("p2");
  });

  it("「管理组合」→ 打开管理弹窗", async () => {
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
