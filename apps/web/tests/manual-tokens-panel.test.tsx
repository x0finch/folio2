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

// 手记账户抽屉的 Tokens | Activity 面板。它本身不录入,只做**编排**:
// · 读:账本 token + 活动 → 两张列表(token 名 / 市值优先用实时 balances,缺则 数量 × 单价;活动新→旧);
//   活动行悬停看明细(单价 / 价值 / 手续费 / 此时账户总额 / 备注),卖超的那笔挂提示;
// · 删:token / 活动都先二次确认,确认才调对应 server fn,失败报一句;
// · 记一笔:+ 号预选最新活动的币;token 行「记一笔」锁定该币;活动行「编辑」预填那一笔;
//   提交后服务端可能「好好地拒绝」(卖超,ok:false)→ 弹窗留着报原因;抛错 → 报失败;成功才关窗。
//
// 录入弹窗本身另有测试(manual-activity-modal.test.tsx),这里换成一个桩:只回显父级给它的 props,
// 并能替用户按下「提交 / 保存」—— 测的是面板给弹窗什么、拿到草稿后发什么。
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
// manualAccountQuery 所在的查询模块还引着这两处 server fn —— 本面板用不到,桩掉免得拉进 Worker 运行时。
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
// 删除确认是 MorphingModal:退场动画在 jsdom 里不一定走完,换直通好让「关了」就是关了。
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
    act("a4", "t2", "reduce", 5, at(2024, 3, 1)), // 当时只有 2 → 卖超
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
    [...body().querySelectorAll('[role="tab"]')].find(
      (x) => x.textContent?.trim() === label,
    ) as HTMLElement;
  // Tabs 根下:[页头(tab 列表 + 加号), Tokens 面板, Activity 面板]。
  const panel = (which: "tokens" | "activity") => {
    const root = utils.container.querySelector('[role="tablist"]')?.parentElement?.parentElement;
    return root?.children[which === "tokens" ? 1 : 2] as HTMLElement;
  };
  // 某一行(按行内文字认)上的滑动操作钮:从那段文字往上找,第一个带这个操作钮的祖先就是这一行。
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

// 活动行数量那一格就是悬停触发区(最内层那个 div;mouseenter 不冒泡,外层收不到)。
const hoverTrigger = (text: string) =>
  [...document.body.querySelectorAll("div")]
    .filter((d) => d.textContent === text)
    .at(-1) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  s.modal = null;
});

describe("ManualTokensPanel — 列表", () => {
  it("还在读账本 → 不提前说「没有」", async () => {
    const m = mount(new Promise(() => {}));
    await waitFor(() => expect(s.getManualAccount).toHaveBeenCalled());
    expect(m.text()).not.toContain(t.tokensEmpty);
    expect(m.text()).not.toContain(t.empty);
  });

  it("账本空 → 两个 tab 各自的空态", async () => {
    const m = mount({ tokens: [], activities: [] });
    await waitFor(() => expect(m.text()).toContain(t.tokensEmpty));
    expect(m.text()).toContain(t.empty);
  });

  it("Tokens:名字 / 市值优先用实时 balances;缺 balance 的回退 大写代号 + 数量 × 单价", async () => {
    const m = mount();
    await m.ready();
    const tokens = m.panel("tokens").textContent ?? "";
    expect(tokens).toContain("Bitcoin");
    expect(tokens).toContain("90,000"); // balances 的实时市值,不是 1.5 × 50000
    expect(tokens).not.toContain("75,000");
    expect(tokens).toContain("ETH");
    expect(tokens).not.toContain("eth"); // 名字位用大写代号
    expect(tokens).toContain("6,000"); // 2 × 3000
  });

  it("Activity:新→旧排列,带类型与备注;有单价的显示价值", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    const acts = m.panel("activity").textContent ?? "";
    const order = ["5 ETH", "0.5 BTC", "2 ETH", "1 BTC"].map((x) => acts.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(acts).toContain(t.reduce);
    expect(acts).toContain("dca buy");
    expect(acts).toContain("$25,000.00"); // 0.5 × 50000
  });

  it("活动行悬停 → 明细:单价 / 手续费 / 此时账户总额 / 备注", async () => {
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
    // 2/1 那一刻:BTC 1.5 × 50000 + ETH 2 × 3000 = 81,000
    expect(txt).toContain(t.accountTotalThen);
    expect(txt).toContain("$81,000.00");
    expect(txt).toContain("dca buy");
    expect(txt).not.toContain(t.oversoldNotice);
  });

  it("卖超的那笔 → 明细里如实提示", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.tab(t.title));
    const trigger = hoverTrigger("5 ETH");
    fireEvent.mouseEnter(trigger);
    expect(document.body.textContent).toContain(t.oversoldNotice);
  });
});

describe("ManualTokensPanel — 删除", () => {
  it("删 token:先确认(标题点名),确认才调 removeManualToken", async () => {
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

  it("确认框点取消 → 不删", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.action("Bitcoin", tc.delete));
    await waitFor(() => expect(m.button(tc.cancel)).toBeTruthy());
    fireEvent.click(m.button(tc.cancel) as HTMLElement);
    await waitFor(() => expect(m.text()).not.toContain(t.confirmDeleteBody));
    expect(s.removeManualToken).not.toHaveBeenCalled();
  });

  it("删 token 失败 → 报一句", async () => {
    s.removeManualToken.mockRejectedValue(new Error("boom"));
    const m = mount();
    await m.ready();
    fireEvent.click(m.action("Bitcoin", tc.delete));
    await waitFor(() => expect(m.button(tc.delete)).toBeTruthy());
    fireEvent.click(m.button(tc.delete) as HTMLElement);
    await waitFor(() => expect(s.toastError).toHaveBeenCalledWith(ta.actionFailed));
  });

  it("删活动:确认后调 removeManualActivity(那一笔)", async () => {
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

  it("删活动失败 → 报一句", async () => {
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

describe("ManualTokensPanel — 记一笔 / 编辑", () => {
  it("+ 号 → 打开弹窗,预选最新一笔活动的币,不锁定", async () => {
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    expect(s.modal?.open).toBe(true);
    // 最新一笔是 3/1 的 ETH reduce。
    expect(s.modal?.defaultToken).toMatchObject({ symbol: "eth", unitPrice: 3000 });
    expect(s.modal?.lockToken).toBe(false);
    expect(s.modal?.edit).toBeNull();
  });

  it("token 行「记一笔」→ 锁定那个币(带票、名字、单价)", async () => {
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

  it("活动行「编辑」→ 预填那一笔的全部字段", async () => {
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

  it("提交 → createManualActivities(缺省字段补 null);成功关窗并切到 Activity", async () => {
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

  it("服务端判卖超(ok:false)→ 弹窗留着,结果是 over;再次打开时清掉", async () => {
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

  it("提交抛错 → 弹窗留着,结果是 failed", async () => {
    s.createManualActivities.mockRejectedValue(new Error("500"));
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    s.modal?.onSubmit([draft()]);
    await waitFor(() => expect(s.modal?.submitResult).toBe("failed"));
    expect(s.modal?.open).toBe(true);
  });

  it("在飞时弹窗拿到 pending", async () => {
    s.createManualActivities.mockImplementation(() => new Promise(() => {}));
    const m = mount();
    await m.ready();
    fireEvent.click(m.plus());
    s.modal?.onSubmit([draft()]);
    await waitFor(() => expect(s.modal?.pending).toBe(true));
  });

  it("编辑保存 → updateManualActivity(那一笔, 缺省字段补 null);成功关窗", async () => {
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

  it("编辑被判卖超 → 弹窗留着,结果是 over", async () => {
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
