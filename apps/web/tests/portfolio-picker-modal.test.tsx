import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioSummary } from "@/lib/hooks/use-portfolio";
import { messages } from "@/lib/i18n/messages";

// Portfolio modal in manage mode (rename / set default / delete) and move mode (assign an account).
// AnimatePresence is a pass-through: exit animations may not finish in jsdom, so an old page would
// linger and make "back to the list" assertions vacuous.
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
  // Find "plain" buttons by visible text; swipe action buttons share the text but have aria-label.
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

describe("PortfolioPickerModal — closed", () => {
  it("open=false -> renders nothing", () => {
    const { heading } = mount({ mode: "manage", open: false });
    expect(heading()).toEqual([]);
  });
});

describe("PortfolioPickerModal — manage", () => {
  it("lists all portfolios, the default one has a Default badge; only non-defaults offer set default / delete", () => {
    const { heading, text, byLabel } = mount({ mode: "manage" });
    expect(heading()).toEqual([tp.manageTitle]);
    for (const p of PORTFOLIOS) expect(text()).toContain(p.name);
    expect(text()).toContain(tp.defaultBadge);
    expect(byLabel(tp.setDefault)).toHaveLength(2);
    expect(byLabel(tc.delete)).toHaveLength(2);
  });

  it("set as default -> setDefaultPortfolio(that portfolio)", async () => {
    fns.setDefaultPortfolio.mockResolvedValue(undefined);
    const { byLabel } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tp.setDefault)[0]); // first non-default: p2
    await waitFor(() =>
      expect(fns.setDefaultPortfolio).toHaveBeenCalledWith({ data: { portfolioId: "p2" } }),
    );
  });

  it("set default fails -> error shown", async () => {
    fns.setDefaultPortfolio.mockRejectedValue(new Error("boom"));
    const { byLabel } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tp.setDefault)[0]);
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.manageFailed));
  });

  it("rename -> renamePortfolio(id, new name), exits edit mode on success", async () => {
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

  it("rename fails -> error shown, stays in edit mode", async () => {
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

  it("delete -> confirm page; cancel returns to the list without deleting", async () => {
    const { byLabel, byText, heading, text } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.delete)[1]); // p3
    await waitFor(() => expect(heading()).toEqual([tp.deleteTitle]));
    expect(text()).toContain(tp.deleteConfirm.replace("{name}", "Cold"));

    fireEvent.click(byText(tc.cancel));
    await waitFor(() => expect(heading()).toEqual([tp.manageTitle]));
    expect(fns.deletePortfolio).not.toHaveBeenCalled();
  });

  it("confirm delete -> deletePortfolio(that portfolio), success toast and back to the list", async () => {
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

  it("delete fails -> error shown, stays on the confirm page", async () => {
    fns.deletePortfolio.mockRejectedValue(new Error("boom"));
    const { byLabel, byText, heading } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.delete)[1]);
    await waitFor(() => expect(heading()).toEqual([tp.deleteTitle]));
    fireEvent.click(byText(tc.delete));
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.manageFailed));
    expect(heading()).toEqual([tp.deleteTitle]);
  });

  it("top-right close / first-level backdrop -> onClose", () => {
    const { byLabel, onClose } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.close)[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(byLabel("Close modal")[0]);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("second level (delete confirm) backdrop -> only back to the list, modal stays open", async () => {
    const { byLabel, heading, onClose } = mount({ mode: "manage" });
    fireEvent.click(byLabel(tc.delete)[0]);
    await waitFor(() => expect(heading()).toEqual([tp.deleteTitle]));
    fireEvent.click(byLabel("Close modal")[0]);
    await waitFor(() => expect(heading()).toEqual([tp.manageTitle]));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("PortfolioPickerModal — move", () => {
  it("current portfolio is marked current; clicking it sends nothing", async () => {
    const { byText } = mount({ mode: "move", currentPortfolioId: "p2" });
    const current = byText("Degen");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(byText("Main").getAttribute("aria-current")).toBe("false");
    fireEvent.click(current);
    await new Promise((r) => setTimeout(r, 0));
    expect(fns.moveAccountToPortfolio).not.toHaveBeenCalled();
  });

  it("clicking another -> moveAccountToPortfolio(account, target), closes with a toast on success", async () => {
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

  it("move fails -> error shown, modal stays open", async () => {
    fns.moveAccountToPortfolio.mockRejectedValue(new Error("boom"));
    const { byText, onClose } = mount({ mode: "move", currentPortfolioId: "p2" });
    fireEvent.click(byText("Cold"));
    await waitFor(() => expect(fns.toastError).toHaveBeenCalledWith(tp.moveFailed));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("new portfolio: cannot submit when empty; filled -> createPortfolio(trimmed name), back to the list", async () => {
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

  it("create fails -> error shown, stays on the create page", async () => {
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

  it("cancel on the create page -> back to the list, nothing created", async () => {
    const { byText, heading } = mount({ mode: "move", currentPortfolioId: "p1" });
    fireEvent.click(byText(tp.createBadge));
    await waitFor(() => expect(heading()).toEqual([tp.createTitle]));
    fireEvent.click(byText(tc.cancel));
    await waitFor(() => expect(heading()).toEqual([tp.moveToTitle]));
    expect(fns.createPortfolio).not.toHaveBeenCalled();
  });
});
