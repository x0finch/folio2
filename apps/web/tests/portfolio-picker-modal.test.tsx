import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioSummary } from "@/lib/hooks/use-portfolio";
import { messages } from "@/lib/i18n/messages";

// Portfolio 弹窗的两种用法(ADR 0033):
// · manage:改名 / 设默认 / 删除(删除走二层确认页)—— 默认组合不给设默认、不给删;
// · move:把账户归到某个组合,当前所在那个点了不发请求;左下角进二层新建组合。
// 钉住的是「每个动作调哪个 server fn、带什么参数、成功 / 失败之后界面落在哪」:
// 成功回到列表(或关窗),失败报一句且不关、不丢用户正在做的事。
//
// AnimatePresence 换成直通:页与页之间的 morph 是 MorphingModal 的事;这里要的是「现在显示哪一页」,
// 而 jsdom 里退场动画不一定走完,旧页会赖在 DOM 里让「回到列表」这种断言恒真。
const fns = vi.hoisted(() => ({
  createPortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  moveAccountToPortfolio: vi.fn(),
  renamePortfolio: vi.fn(),
  setDefaultPortfolio: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/server/portfolios", () => ({
  createPortfolio: fns.createPortfolio,
  deletePortfolio: fns.deletePortfolio,
  moveAccountToPortfolio: fns.moveAccountToPortfolio,
  renamePortfolio: fns.renamePortfolio,
  setDefaultPortfolio: fns.setDefaultPortfolio,
}));
vi.mock("motion/react", async (orig) => ({
  ...(await orig<object>()),
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: fns.toastError, success: fns.toastSuccess, message: vi.fn() },
}));
const PORTFOLIOS: PortfolioSummary[] = [
  { id: "p1", name: "Main", isDefault: true },
  { id: "p2", name: "Degen", isDefault: false },
  { id: "p3", name: "Cold", isDefault: false },
];
vi.mock("@/lib/hooks/use-portfolio", () => ({
  usePortfolio: () => ({
    portfolios: PORTFOLIOS,
    selectedId: "p1",
    defaultId: "p1",
    select: vi.fn(),
  }),
}));

const { PortfolioPickerModal } = await import("@/components/portfolio-picker-modal");

const tp = messages.en.Portfolio;
const tc = messages.en.Common;

function mount(props: { mode: "manage" | "move"; open?: boolean; currentPortfolioId?: string }) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <PortfolioPickerModal
          mode={props.mode}
          accountId="acc1"
          currentPortfolioId={props.currentPortfolioId}
          open={props.open ?? true}
          onClose={onClose}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const buttons = () => [...document.body.querySelectorAll("button")];
  // 按可见文字找「普通」按钮:滑动操作钮也带同样的文字,但它们有 aria-label,排除掉。
  const byText = (text: string) =>
    buttons().find(
      (b) => b.textContent?.trim() === text && !b.hasAttribute("aria-label"),
    ) as HTMLButtonElement;
  const byLabel = (label: string) =>
    buttons().filter((b) => b.getAttribute("aria-label") === label) as HTMLButtonElement[];
  const heading = () => [...document.body.querySelectorAll("h2")].map((h) => h.textContent);
  const text = () => document.body.textContent ?? "";
  return { ...utils, onClose, byText, byLabel, heading, text };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PortfolioPickerModal — 关着", () => {
  it("open=false → 什么都不渲染", () => {
    const { heading } = mount({ mode: "manage", open: false });
    expect(heading()).toEqual([]);
  });
});

describe("PortfolioPickerModal — manage", () => {
  it("列出全部组合,默认那个带 Default 徽标;只有非默认的有「设默认 / 删除」", () => {
    const { heading, text, byLabel } = mount({ mode: "manage" });
    expect(heading()).toEqual([tp.manageTitle]);
    for (const p of PORTFOLIOS) expect(text()).toContain(p.name);
    expect(text()).toContain(tp.defaultBadge);
    expect(byLabel(tp.setDefault)).toHaveLength(2);
    expect(byLabel(tc.delete)).toHaveLength(2);
  });

  it("设为默认 → setDefaultPortfolio(该组合)", async () => {
    fns.setDefaultPortfolio.mockResolvedValue(undefined);
    const { byLabel } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tp.setDefault)[0]); // 第一个非默认:p2
    await waitFor(() =>
      expect(fns.setDefaultPortfolio).toHaveBeenCalledWith({ data: { portfolioId: "p2" } }),
    );
  });

  it("设默认失败 → 报错", async () => {
    fns.setDefaultPortfolio.mockRejectedValue(new Error("boom"));
    const { byLabel } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tp.setDefault)[0]);
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.manageFailed));
  });

  it("改名 → renamePortfolio(id, 新名),成功后退出编辑", async () => {
    fns.renamePortfolio.mockResolvedValue(undefined);
    const { byText } = mount({ mode: "manage" });
    fireEvent.click(byText("Degen"));
    const input = document.body.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Moon" } });
    fireEvent.click(byText(tc.save));
    await waitFor(() =>
      expect(fns.renamePortfolio).toHaveBeenCalledWith({
        data: { portfolioId: "p2", name: "Moon" },
      }),
    );
    await waitFor(() => expect(document.body.querySelector("input")).toBeNull());
  });

  it("改名失败 → 报错,留在编辑态", async () => {
    fns.renamePortfolio.mockRejectedValue(new Error("boom"));
    const { byText } = mount({ mode: "manage" });
    fireEvent.click(byText("Degen"));
    fireEvent.change(document.body.querySelector("input") as HTMLInputElement, {
      target: { value: "Moon" },
    });
    fireEvent.click(byText(tc.save));
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.manageFailed));
    expect((document.body.querySelector("input") as HTMLInputElement).value).toBe("Moon");
  });

  it("删除 → 进确认页;取消回列表,不删", async () => {
    const { byLabel, byText, heading, text } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.delete)[1]); // p3
    await waitFor(() => expect(heading()).toEqual([tp.deleteTitle]));
    expect(text()).toContain(tp.deleteConfirm.replace("{name}", "Cold"));

    fireEvent.click(byText(tc.cancel));
    await waitFor(() => expect(heading()).toEqual([tp.manageTitle]));
    expect(fns.deletePortfolio).not.toHaveBeenCalled();
  });

  it("确认删除 → deletePortfolio(该组合),成功提示并回到列表", async () => {
    fns.deletePortfolio.mockResolvedValue(undefined);
    const { byLabel, byText, heading } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.delete)[1]);
    await waitFor(() => expect(heading()).toEqual([tp.deleteTitle]));

    fireEvent.click(byText(tc.delete));
    await waitFor(() =>
      expect(fns.deletePortfolio).toHaveBeenCalledWith({ data: { portfolioId: "p3" } }),
    );
    await waitFor(() => expect(fns.toastSuccess).toHaveBeenCalledWith(tp.deleted));
    await waitFor(() => expect(heading()).toEqual([tp.manageTitle]));
  });

  it("删除失败 → 报错,留在确认页", async () => {
    fns.deletePortfolio.mockRejectedValue(new Error("boom"));
    const { byLabel, byText, heading } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.delete)[1]);
    await waitFor(() => expect(heading()).toEqual([tp.deleteTitle]));
    fireEvent.click(byText(tc.delete));
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.manageFailed));
    expect(heading()).toEqual([tp.deleteTitle]);
  });

  it("右上角叉叉 / 一层遮罩 → onClose", () => {
    const { byLabel, onClose } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.close)[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(byLabel("Close modal")[0]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("二层(删除确认)点遮罩 → 只退回列表,不关整个弹窗", async () => {
    const { byLabel, heading, onClose } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.delete)[0]);
    await waitFor(() => expect(heading()).toEqual([tp.deleteTitle]));
    fireEvent.click(byLabel("Close modal")[0]);
    await waitFor(() => expect(heading()).toEqual([tp.manageTitle]));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("PortfolioPickerModal — move", () => {
  it("当前所在的组合标成 current;点它不发请求", async () => {
    const { byText } = mount({ mode: "move", currentPortfolioId: "p2" });
    const current = byText("Degen");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(byText("Main").getAttribute("aria-current")).toBe("false");
    fireEvent.click(current);
    await new Promise((r) => setTimeout(r, 0));
    expect(fns.moveAccountToPortfolio).not.toHaveBeenCalled();
  });

  it("点另一个 → moveAccountToPortfolio(账户, 目标),成功后关窗并提示", async () => {
    fns.moveAccountToPortfolio.mockResolvedValue(undefined);
    const { byText, onClose } = mount({ mode: "move", currentPortfolioId: "p2" });
    fireEvent.click(byText("Cold"));
    await waitFor(() =>
      expect(fns.moveAccountToPortfolio).toHaveBeenCalledWith({
        data: { accountId: "acc1", portfolioId: "p3" },
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(() => expect(fns.toastSuccess).toHaveBeenCalledWith(tp.moved));
  });

  it("移动失败 → 报错,不关窗", async () => {
    fns.moveAccountToPortfolio.mockRejectedValue(new Error("boom"));
    const { byText, onClose } = mount({ mode: "move", currentPortfolioId: "p2" });
    fireEvent.click(byText("Cold"));
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.moveFailed));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("新建组合:名字为空时不可提交;填了 → createPortfolio(去空白的名字),建完回列表", async () => {
    fns.createPortfolio.mockResolvedValue({ id: "p4", name: "New" });
    const { byText, heading } = mount({ mode: "move", currentPortfolioId: "p1" });
    fireEvent.click(byText(tp.createBadge));
    await waitFor(() => expect(heading()).toEqual([tp.createTitle]));

    expect(byText(tc.create).disabled).toBe(true);
    fireEvent.change(document.body.querySelector("input") as HTMLInputElement, {
      target: { value: "  New  " },
    });
    fireEvent.click(byText(tc.create));

    await waitFor(() =>
      expect(fns.createPortfolio).toHaveBeenCalledWith({ data: { name: "New" } }),
    );
    await waitFor(() => expect(heading()).toEqual([tp.moveToTitle]));
  });

  it("新建失败 → 报错,留在新建页", async () => {
    fns.createPortfolio.mockRejectedValue(new Error("boom"));
    const { byText, heading } = mount({ mode: "move", currentPortfolioId: "p1" });
    fireEvent.click(byText(tp.createBadge));
    await waitFor(() => expect(heading()).toEqual([tp.createTitle]));
    fireEvent.change(document.body.querySelector("input") as HTMLInputElement, {
      target: { value: "New" },
    });
    fireEvent.click(byText(tc.create));
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.manageFailed));
    expect(heading()).toEqual([tp.createTitle]);
  });

  it("新建页取消 → 回列表,不建", async () => {
    const { byText, heading } = mount({ mode: "move", currentPortfolioId: "p1" });
    fireEvent.click(byText(tp.createBadge));
    await waitFor(() => expect(heading()).toEqual([tp.createTitle]));
    fireEvent.click(byText(tc.cancel));
    await waitFor(() => expect(heading()).toEqual([tp.moveToTitle]));
    expect(fns.createPortfolio).not.toHaveBeenCalled();
  });
});
