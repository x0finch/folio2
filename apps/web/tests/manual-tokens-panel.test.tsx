import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityDraft,
  ActivityPatch,
  EditActivityInput,
  PickedToken,
  SubmitResult,
} from "@/components/manual-activity-modal";
import type { OverviewBalance } from "@/lib/core/account-view";
import { messages } from "@/lib/i18n/messages";
import { tabLabel, tabPanel } from "./helpers/tabs";

// The panel only orchestrates (list, delete with confirm, open the entry modal, send drafts); the
// modal has its own tests, so here it is a stub that echoes props and can press submit/save.
const s = vi.hoisted(() => ({
  getManualAccount: vi.fn(),
  removeManualToken: vi.fn(),
  createManualActivities: vi.fn(),
  removeManualActivity: vi.fn(),
  updateManualActivity: vi.fn(),
  toastError: vi.fn(),
  modal: null as null | {
    open: boolean;
    defaultToken?: PickedToken | null;
    lockToken?: boolean;
    edit?: EditActivityInput | null;
    pending: boolean;
    submitResult: SubmitResult;
    onSubmit: (drafts: ActivityDraft[]) => void;
    onEdit: (tokenId: string, activityId: string, patch: ActivityPatch) => void;
    onClose: () => void;
  },
}));

vi.mock("@/lib/server/manual-tokens", () => ({
  getManualAccount: s.getManualAccount,
  removeManualToken: s.removeManualToken,
}));
// The query module still imports these server fns; stub them to keep the Worker runtime out.
vi.mock("@/lib/server/accounts", () => ({ getAccountHistory: vi.fn(), listAccounts: vi.fn() }));
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory: vi.fn() }));
vi.mock("@/lib/server/manual-activities", () => ({
  createManualActivities: s.createManualActivities,
  removeManualActivity: s.removeManualActivity,
  updateManualActivity: s.updateManualActivity,
}));
vi.mock("@/components/manual-activity-modal", () => ({
  ManualActivityModal: (props: NonNullable<typeof s.modal>) => {
    s.modal = props;
    return props.open ? <div data-testid="activity-modal" /> : null;
  },
}));
// MorphingModal's exit animation may never finish in jsdom; pass through so closed means closed.
vi.mock("motion/react", async (orig) => ({
  ...(await orig<object>()),
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: s.toastError, success: vi.fn(), message: vi.fn() },
}));

const { ManualTokensPanel } = await import("@/components/manual-tokens-panel");

const t = messages.en.Activity;
const ta = messages.en.Accounts;
const tc = messages.en.Common;

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0).getTime();
const act = (
  id: string,
  tokenId: string,
  kind: "add" | "reduce" | "set",
  amount: number,
  occurredAt: number,
  extra: { price?: number; fee?: number; memo?: string } = {},
) => ({
  id,
  accountId: "acc1",
  tokenId,
  kind,
  amount,
  occurredAt,
  createdAt: occurredAt,
  price: extra.price ?? null,
  fee: extra.fee ?? null,
  memo: extra.memo ?? null,
});

const DETAIL = {
  tokens: [
    { id: "t1", symbol: "btc", unitPrice: 50000, ticket: "tk:btc", amount: 1.5 },
    { id: "t2", symbol: "eth", unitPrice: 3000, ticket: null, amount: 2 },
  ],
  activities: [
    act("a1", "t1", "set", 1, at(2024, 1, 1), { price: 40000 }),
    act("a2", "t1", "add", 0.5, at(2024, 2, 1), { price: 50000, fee: 2, memo: "dca buy" }),
    act("a3", "t2", "set", 2, at(2024, 1, 15), { price: 3000 }),
    act("a4", "t2", "reduce", 5, at(2024, 3, 1)), // only 2 held then -> oversold
  ],
};

const BALANCES = [
  {
    id: "b1",
    symbol: "BTC",
    name: "Bitcoin",
    amount: 1.5,
    usdValue: 90000,
    kind: "spot",
    metaJson: null,
  } as OverviewBalance,
];

function mount(detail: unknown = DETAIL) {
  if (detail instanceof Promise) s.getManualAccount.mockReturnValue(detail);
  else s.getManualAccount.mockResolvedValue(detail);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <ManualTokensPanel accountId="acc1" balances={BALANCES} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const body = () => document.body;
  const tab = (label: string) =>
    [...body().querySelectorAll('[role="tab"]')].find((x) => tabLabel(x) === label) as HTMLElement;
  const panel = (which: "tokens" | "activity") =>
    tabPanel(body().querySelectorAll('[role="tab"]')[which === "tokens" ? 0 : 1]);
  // Swipe action button on a row: walk up from the row's text to the first ancestor that has it.
  const action = (rowText: string, label: string) => {
    const leaf = [...utils.container.querySelectorAll("span, div")].find(
      (e) => e.textContent?.includes(rowText) && e.children.length === 0,
    );
    for (let el = leaf?.parentElement; el; el = el.parentElement) {
      const b = el.querySelector(`button[aria-label="${label}"]`);
      if (b) return b as HTMLElement;
    }
    throw new Error(`no "${label}" action on row "${rowText}"`);
  };
  const plus = () =>
    utils.container.querySelector(`button[aria-label="${t.addActivityTitle}"]`) as HTMLElement;
  const button = (text: string) =>
    [...body().querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text && !b.hasAttribute("aria-label"),
    ) as HTMLElement | undefined;
  const text = () => body().textContent ?? "";
  const ready = () => waitFor(() => expect(text()).toContain("Bitcoin"));
  return { ...utils, tab, panel, action, plus, button, text, ready };
}

// The quantity cell is the hover target (innermost div; mouseenter does not bubble).
const hoverTrigger = (text: string) =>
  [...document.body.querySelectorAll("div")]
    .filter((d) => d.textContent === text)
    .at(-1) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  s.modal = null;
});

describe("ManualTokensPanel — list", () => {
  it("still loading the ledger -> does not prematurely say empty", async () => {
    const m = mount(new Promise(() => {}));
    await waitFor(() => expect(s.getManualAccount).toHaveBeenCalled());
    expect(m.text()).not.toContain(t.tokensEmpty);
    expect(m.text()).not.toContain(t.empty);
  });

  it("empty ledger -> each tab shows its empty state", async () => {
    const m = mount({ tokens: [], activities: [] });
    await waitFor(() => expect(m.text()).toContain(t.tokensEmpty));
    expect(m.text()).toContain(t.empty);
  });

  it("Tokens: name / value prefer live balances; missing balance falls back to uppercase ticker + qty x price", async () => {
    const m = mount();
    await m.ready();
    const tokens = m.panel("tokens").textContent ?? "";
    expect(tokens).toContain("Bitcoin");
    expect(tokens).toContain("90,000"); // live balance value, not 1.5 x 50000
    expect(tokens).not.toContain("75,000");
    expect(tokens).toContain("ETH");
    expect(tokens).not.toContain("eth"); // name uses the uppercase ticker
    expect(tokens).toContain("6,000"); // 2 x 3000
  });

  it("Activity: newest first, with type and note; value shown when priced", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    const acts = m.panel("activity").textContent ?? "";
    const order = ["5 ETH", "0.5 BTC", "2 ETH", "1 BTC"].map((x) => acts.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(acts).toContain(t.reduce);
    expect(acts).toContain("dca buy");
    expect(acts).toContain("$25,000.00"); // 0.5 x 50000
  });

  it("hovering an activity row -> details: unit price / fee / account total then / note", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    const trigger = hoverTrigger("0.5 BTC");
    fireEvent.mouseEnter(trigger);
    const detail = [...document.body.querySelectorAll("div")].find(
      (d) => d.style.position === "fixed",
    ) as HTMLElement;
    const txt = detail.textContent ?? "";
    expect(txt).toContain(t.priceLabel);
    expect(txt).toContain("$50,000.00");
    expect(txt).toContain(t.feeLabel);
    expect(txt).toContain("$2.00");
    // At 2/1: BTC 1.5 x 50000 + ETH 2 x 3000 = 81,000
    expect(txt).toContain(t.accountTotalThen);
    expect(txt).toContain("$81,000.00");
    expect(txt).toContain("dca buy");
    expect(txt).not.toContain(t.oversoldNotice);
  });

  it("oversold activity -> details say so", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    const trigger = hoverTrigger("5 ETH");
    fireEvent.mouseEnter(trigger);
    expect(document.body.textContent).toContain(t.oversoldNotice);
  });
});

describe("ManualTokensPanel — delete", () => {
  it("delete token: confirm first (title names it), only then removeManualToken", async () => {
    s.removeManualToken.mockResolvedValue(undefined);
    const m = mount();
    await m.ready();
    fireEvent.click(m.action("Bitcoin", tc.delete));
    await waitFor(() =>
      expect(m.text()).toContain(t.confirmDeleteToken.replace("{symbol}", "BTC")),
    );
    expect(s.removeManualToken).not.toHaveBeenCalled();

    fireEvent.click(m.button(tc.delete) as HTMLElement);
    await waitFor(() =>
      expect(s.removeManualToken).toHaveBeenCalledWith({
        data: { accountId: "acc1", tokenId: "t1" },
      }),
    );
  });

  it("cancel in the confirm dialog -> nothing deleted", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.action("Bitcoin", tc.delete));
    await waitFor(() => expect(m.button(tc.cancel)).toBeTruthy());
    fireEvent.click(m.button(tc.cancel) as HTMLElement);
    await waitFor(() => expect(m.text()).not.toContain(t.confirmDeleteBody));
    expect(s.removeManualToken).not.toHaveBeenCalled();
  });

  it("delete token fails -> reports an error", async () => {
    s.removeManualToken.mockRejectedValue(new Error("boom"));
    const m = mount();
    await m.ready();
    fireEvent.click(m.action("Bitcoin", tc.delete));
    await waitFor(() => expect(m.button(tc.delete)).toBeTruthy());
    fireEvent.click(m.button(tc.delete) as HTMLElement);
    await waitFor(() => expect(s.toastError).toHaveBeenCalledWith(ta.actionFailed));
  });

  it("delete activity: after confirm calls removeManualActivity (that entry)", async () => {
    s.removeManualActivity.mockResolvedValue(undefined);
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    fireEvent.click(m.action("dca buy", tc.delete));
    await waitFor(() => expect(m.text()).toContain(t.confirmDeleteActivity));
    fireEvent.click(m.button(tc.delete) as HTMLElement);
    await waitFor(() =>
      expect(s.removeManualActivity).toHaveBeenCalledWith({
        data: { accountId: "acc1", activityId: "a2" },
      }),
    );
  });

  it("delete activity fails -> reports an error", async () => {
    s.removeManualActivity.mockRejectedValue(new Error("boom"));
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    fireEvent.click(m.action("dca buy", tc.delete));
    await waitFor(() => expect(m.button(tc.delete)).toBeTruthy());
    fireEvent.click(m.button(tc.delete) as HTMLElement);
    await waitFor(() => expect(s.toastError).toHaveBeenCalledWith(ta.actionFailed));
  });
});

describe("ManualTokensPanel — record / edit", () => {
  it("+ button -> opens modal, preselects the latest activity's token, not locked", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    expect(s.modal?.open).toBe(true);
    // The latest is the 3/1 ETH reduce.
    expect(s.modal?.defaultToken).toMatchObject({ symbol: "eth", unitPrice: 3000 });
    expect(s.modal?.lockToken).toBe(false);
    expect(s.modal?.edit).toBeNull();
  });

  it("token row 'record' -> locks that token (ticker, name, unit price)", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.action("Bitcoin", t.addActivityTitle));
    expect(s.modal?.open).toBe(true);
    expect(s.modal?.lockToken).toBe(true);
    expect(s.modal?.defaultToken).toMatchObject({
      symbol: "btc",
      ticket: "tk:btc",
      name: "Bitcoin",
      unitPrice: 50000,
    });
  });

  it("activity row 'edit' -> prefills every field of that entry", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    fireEvent.click(m.action("dca buy", t.editActivityTitle));
    expect(s.modal?.lockToken).toBe(true);
    expect(s.modal?.edit).toMatchObject({
      tokenId: "t1",
      activityId: "a2",
      kind: "add",
      amount: 0.5,
      price: 50000,
      fee: 2,
      memo: "dca buy",
      occurredAt: at(2024, 2, 1),
    });
  });

  const draft = (extra: Partial<ActivityDraft> = {}): ActivityDraft => ({
    token: { symbol: "SOL", unitPrice: 150 },
    kind: "add",
    amount: 3,
    occurredAt: at(2024, 4, 1),
    createdAt: 1,
    ...extra,
  });

  it("submit -> createManualActivities (missing fields as null); success closes and switches to Activity", async () => {
    s.createManualActivities.mockResolvedValue({ ok: true });
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    s.modal?.onSubmit([draft({ price: 140 })]);

    await waitFor(() => expect(s.modal?.open).toBe(false));
    expect(s.createManualActivities).toHaveBeenCalledWith({
      data: {
        accountId: "acc1",
        drafts: [
          {
            token: { symbol: "SOL", unitPrice: 150, ticket: null },
            kind: "add",
            amount: 3,
            occurredAt: at(2024, 4, 1),
            price: 140,
            fee: null,
            memo: null,
          },
        ],
      },
    });
    expect(m.tab(t.title).getAttribute("aria-selected")).toBe("true");
  });

  it("server rejects as oversold (ok:false) -> modal stays, outcome over; cleared on reopen", async () => {
    s.createManualActivities.mockResolvedValue({ ok: false });
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    s.modal?.onSubmit([draft({ kind: "reduce", amount: 99 })]);

    await waitFor(() => expect(s.modal?.submitResult).toBe("over"));
    expect(s.modal?.open).toBe(true);

    s.modal?.onClose();
    await waitFor(() => expect(s.modal?.open).toBe(false));
    fireEvent.click(m.plus());
    await waitFor(() => expect(s.modal?.open).toBe(true));
    expect(s.modal?.submitResult).toBeNull();
  });

  it("submit throws -> modal stays, outcome failed", async () => {
    s.createManualActivities.mockRejectedValue(new Error("500"));
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    s.modal?.onSubmit([draft()]);
    await waitFor(() => expect(s.modal?.submitResult).toBe("failed"));
    expect(s.modal?.open).toBe(true);
  });

  it("in flight -> modal gets pending", async () => {
    s.createManualActivities.mockImplementation(() => new Promise(() => {}));
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    s.modal?.onSubmit([draft()]);
    await waitFor(() => expect(s.modal?.pending).toBe(true));
  });

  it("save edit -> updateManualActivity(that entry, missing fields as null); success closes", async () => {
    s.updateManualActivity.mockResolvedValue({ ok: true });
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    fireEvent.click(m.action("dca buy", t.editActivityTitle));
    s.modal?.onEdit("t1", "a2", { kind: "add", amount: 0.7, occurredAt: at(2024, 2, 2) });

    await waitFor(() => expect(s.modal?.open).toBe(false));
    expect(s.updateManualActivity).toHaveBeenCalledWith({
      data: {
        activityId: "a2",
        patch: {
          kind: "add",
          amount: 0.7,
          occurredAt: at(2024, 2, 2),
          price: null,
          fee: null,
          memo: null,
        },
      },
    });
  });

  it("edit rejected as oversold -> modal stays, outcome over", async () => {
    s.updateManualActivity.mockResolvedValue({ ok: false });
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    fireEvent.click(m.action("dca buy", t.editActivityTitle));
    s.modal?.onEdit("t1", "a2", { kind: "reduce", amount: 99, occurredAt: at(2024, 2, 2) });
    await waitFor(() => expect(s.modal?.submitResult).toBe("over"));
    expect(s.modal?.open).toBe(true);
  });
});
