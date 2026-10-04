import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rangeSince } from "@/lib/core/history-range";
import { messages } from "@/lib/i18n/messages";
import type { AccountRow } from "@/routes/_authed/-accounts/list-rows";

// 账户详情抽屉:头部(名称 / 市值 / 24h / 占比 / 同步时间)+ ⋯ 菜单(同步 / 归档 / 标签 / 移动 / 删除)
// + 就地改名。图表与持仓列表各是独立组件,这里换成替身,只看抽屉交给它们什么。
// 钉住的用户可见行为:
// ① 头部的三种「不显示」:归档 → 不显 24h 与占比、写静态封存日期;缺凭据 → 不显 24h、给「补凭据」;
//    该有却算不出 → 写 `—`,不是空着也不是 0;
// ② 归档账户的历史窗口从**封存那一刻**往回算(否则一年前归档的账户默认窗口里一个点都没有);
// ③ 菜单每一项调对的写接口、带对的参数;同步的三种下场各给对的提示;手记账户没有「同步」;
// ④ 删除要二次确认,成功才关抽屉,失败报错留在原地;改名失败停在输入框里。
const {
  archiveAccount,
  removeAccount,
  renameAccount,
  getAccountHistory,
  syncAccountAndWait,
  toastError,
  toastSuccess,
  toastMessage,
} = vi.hoisted(() => ({
  archiveAccount: vi.fn(),
  removeAccount: vi.fn(),
  renameAccount: vi.fn(),
  getAccountHistory: vi.fn(),
  syncAccountAndWait: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastMessage: vi.fn(),
}));

const never = () => new Promise(() => {});
vi.mock("@/lib/server/accounts", () => ({
  archiveAccount,
  removeAccount,
  renameAccount,
  getAccountHistory,
  listAccounts: vi.fn(never),
}));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors: vi.fn(never),
  getConnectorCredentialSpecs: vi.fn(never),
}));
vi.mock("@/lib/server/holdings", () => ({ getTokenValueHistory: vi.fn(never) }));
vi.mock("@/lib/server/manual-tokens", () => ({ getManualAccount: vi.fn(never) }));
vi.mock("@/lib/server/preferences", () => ({ getCurrencyPreference: vi.fn(never) }));
vi.mock("@/lib/queries/account-sync", () => ({ syncAccountAndWait }));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: toastSuccess, message: toastMessage },
}));
// 图表、持仓列表、两个弹窗:替身只把收到的东西写出来。
vi.mock("@/routes/_authed/-home/hero/trend-panel", () => ({ TrendPanel: () => null }));
vi.mock("@/components/holdings-cards", () => ({
  AccountHoldingsCards: () => <div data-testid="holdings-cards" />,
}));
vi.mock("@/components/manual-tokens-panel", () => ({
  ManualTokensPanel: ({ accountId }: { accountId: string }) => (
    <div data-testid="manual-panel">{accountId}</div>
  ),
}));
vi.mock("@/components/portfolio-picker-modal", () => ({
  PortfolioPickerModal: (p: { open: boolean; accountId: string; currentPortfolioId: string }) =>
    p.open ? <div data-testid="move-modal">{`${p.accountId}@${p.currentPortfolioId}`}</div> : null,
}));
vi.mock("@/components/account-tags-modal", () => ({
  AccountTagsModal: (p: {
    open: boolean;
    portfolioTags: { id: string }[];
    attachedTagIds: string[];
    tagAccountCounts: Record<string, number>;
  }) =>
    p.open ? (
      <div data-testid="tags-modal">
        {JSON.stringify({
          tags: p.portfolioTags.map((t) => t.id),
          attached: p.attachedTagIds,
          counts: p.tagAccountCounts,
        })}
      </div>
    ) : null,
}));

const { AccountDetailSheet } = await import("@/routes/_authed/-accounts/account-detail-sheet");

const HOUR = 3_600_000;
const NOW = Date.now();
const SEALED = Date.UTC(2025, 0, 2);

const row = (over: Partial<AccountRow> = {}): AccountRow => ({
  id: "acc_1",
  label: "Main wallet",
  connectorId: "evm",
  archivedAt: null,
  valuesReady: true,
  totalUsd: 500,
  takenAt: NOW - HOUR,
  balances: [],
  gain24h: { amount: 12.34, pct: 1.5 },
  needsCredentials: false,
  credsSafe: {},
  portfolioId: "p1",
  tags: [],
  ...over,
});

const TAGS = [
  { id: "t1", name: "cold", portfolioId: "p1" },
  { id: "t2", name: "hot", portfolioId: "p1" },
  { id: "tX", name: "other", portfolioId: "p2" },
];
const LINKS = [
  { accountId: "acc_1", tagId: "t1" },
  { accountId: "acc_2", tagId: "t1" },
  { accountId: "acc_2", tagId: "t2" },
];

function mount(account: AccountRow, opts: { total?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onComplete = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(NOW)}>
        <AccountDetailSheet
          account={account}
          total={opts.total ?? 1_000}
          allTags={TAGS as never}
          tagLinks={LINKS as never}
          open
          onOpenChange={onOpenChange}
          onComplete={onComplete}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client, onOpenChange, onComplete };
}

// ⋯ 菜单是 hover 弹出;点触发器同样会打开(触屏走的就是这条)。
async function menuItem(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  return (await screen.findByRole("button", { name })) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  getAccountHistory.mockResolvedValue({ rows: [], live: null, sampled: false });
});

describe("头部", () => {
  it("活跃账户:名字、24h 涨跌、占比、上次同步", async () => {
    mount(row());
    expect(screen.getByText("Main wallet")).toBeTruthy();
    expect(screen.getByText(/1\.50%/)).toBeTruthy();
    expect(screen.getByText(/50\.0% of total/)).toBeTruthy();
    expect(screen.getByText(/Synced/)).toBeTruthy();
  });

  it("归档:标「已归档」,写封存日期,不显 24h 与占比", () => {
    mount(row({ archivedAt: SEALED }));
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText(/Sealed Jan 2, 25/)).toBeTruthy();
    expect(screen.queryByText(/of total/)).toBeNull();
    expect(screen.queryByText(/1\.50%/)).toBeNull();
  });

  it("24h 跌了 → 金额带负号,百分比只写大小(不重复负号)", () => {
    mount(row({ gain24h: { amount: -12.34, pct: -1.5 } }));
    expect(screen.getByText(/1\.50%/)).toBeTruthy();
    expect(screen.queryByText(/-1\.50%/)).toBeNull();
  });

  it("归档的手记账户 → 写封存日期,不写「实时」", () => {
    mount(row({ connectorId: "manual", archivedAt: SEALED }));
    expect(screen.getByText(/Sealed Jan 2, 25/)).toBeTruthy();
    expect(screen.queryByText(/Live/)).toBeNull();
  });

  it("手记账户 → 「实时」,持仓走手记面板", () => {
    mount(row({ connectorId: "manual" }));
    expect(screen.getByText(/Live/)).toBeTruthy();
    expect(screen.getByTestId("manual-panel").textContent).toBe("acc_1");
    expect(screen.queryByTestId("holdings-cards")).toBeNull();
  });

  it("从没同步 → 「从未同步」,持仓走通用卡片", () => {
    mount(row({ takenAt: null }));
    expect(screen.getByText(/Never synced/)).toBeTruthy();
    expect(screen.getByTestId("holdings-cards")).toBeTruthy();
  });

  it("24h 该有但算不出 → 写 —", () => {
    mount(row({ gain24h: null }));
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("缺凭据:不显 24h,点「补凭据」交回这个账户", () => {
    const account = row({ needsCredentials: true });
    const { onComplete } = mount(account);
    expect(screen.queryByText(/1\.50%/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Click to add credentials" }));

    expect(onComplete).toHaveBeenCalledWith(account);
  });

  it("金额没到 → 不写同步时间与持仓(骨架),也不写占比", () => {
    mount(row({ valuesReady: false }));
    expect(screen.queryByText(/Synced/)).toBeNull();
    // 市值位是骨架:不写 24h 那行(写了就是拿占位 0 当真)。
    expect(screen.queryByText(/1\.50%/)).toBeNull();
    expect(screen.queryByText(/of total/)).toBeNull();
    expect(screen.queryByTestId("holdings-cards")).toBeNull();
  });
});

describe("价值历史的窗口", () => {
  it("活跃账户:默认 30 天,带上账户与 connector", async () => {
    mount(row());
    await waitFor(() => expect(getAccountHistory).toHaveBeenCalled());
    const data = getAccountHistory.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ accountId: "acc_1", range: "30d", connectorId: "evm" });
    // 起点按「现在」往回算:离现在 30 天左右,而不是锚在某个过去时刻。
    expect(
      Math.abs((data.since as number) - (rangeSince("30d", Date.now()) as number)),
    ).toBeLessThan(60_000);
  });

  it("归档账户:窗口从封存那一刻往回算", async () => {
    mount(row({ archivedAt: SEALED }));
    await waitFor(() => expect(getAccountHistory).toHaveBeenCalled());
    expect(getAccountHistory.mock.calls[0]?.[0].data.since).toBe(rangeSince("30d", SEALED));
  });

  it("切到 7D → 按 7 天窗口重新取", async () => {
    mount(row());
    await waitFor(() => expect(getAccountHistory).toHaveBeenCalled());

    fireEvent.click(screen.getByText("7D"));

    await waitFor(() =>
      expect(getAccountHistory).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ accountId: "acc_1", range: "7d" }),
      }),
    );
  });
});

describe("⋯ 菜单:同步", () => {
  it("成功 → 同步这个账户并提示已同步", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: true });
    const { client } = mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Synced 1 account."));
    expect(syncAccountAndWait).toHaveBeenCalledWith(client, "acc_1");
  });

  it("因缺凭据被跳过 → 告诉用户还缺凭据", async () => {
    syncAccountAndWait.mockResolvedValue({
      ok: false,
      skipped: true,
      skipReason: "missing-credentials",
    });
    mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() =>
      expect(toastMessage).toHaveBeenCalledWith(
        "Nothing synced — this account is still missing credentials.",
      ),
    );
  });

  it("失败 → 报上游原话", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: false, error: "429 from upstream" });
    mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("429 from upstream"));
  });

  it("发起本身失败(网络)→ 通用失败文案", async () => {
    syncAccountAndWait.mockRejectedValue(new Error("network"));
    mount(row());
    fireEvent.click(await menuItem("Sync"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Sync failed."));
  });

  it("手记账户没有「同步」这一项", async () => {
    mount(row({ connectorId: "manual" }));
    await menuItem("Archive");
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
  });

  it("归档账户的「同步」禁用", async () => {
    mount(row({ archivedAt: SEALED }));
    expect((await menuItem("Sync")).disabled).toBe(true);
  });
});

describe("⋯ 菜单:归档 / 标签 / 移动", () => {
  it("活跃账户 → 归档", async () => {
    archiveAccount.mockResolvedValue(undefined);
    mount(row());
    fireEvent.click(await menuItem("Archive"));
    await waitFor(() =>
      expect(archiveAccount).toHaveBeenCalledWith({ data: { accountId: "acc_1", archived: true } }),
    );
  });

  it("归档账户 → 这一项变成「取消归档」", async () => {
    archiveAccount.mockResolvedValue(undefined);
    mount(row({ archivedAt: SEALED }));
    fireEvent.click(await menuItem("Unarchive"));
    await waitFor(() =>
      expect(archiveAccount).toHaveBeenCalledWith({
        data: { accountId: "acc_1", archived: false },
      }),
    );
  });

  it("归档失败 → 报错", async () => {
    archiveAccount.mockRejectedValue(new Error("boom"));
    mount(row());
    fireEvent.click(await menuItem("Archive"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Action failed."));
  });

  it("标签 → 弹窗只拿本组合的 Tag、本账户已打的那几个、以及每个 Tag 的账户数", async () => {
    mount(row());
    fireEvent.click(await menuItem("Tags"));
    expect(JSON.parse(screen.getByTestId("tags-modal").textContent ?? "")).toEqual({
      tags: ["t1", "t2"],
      attached: ["t1"],
      counts: { t1: 2, t2: 1 },
    });
  });

  it("移动 → 组合选择弹窗拿到这个账户与它现在所在的组合", async () => {
    mount(row());
    fireEvent.click(await menuItem("Move to…"));
    expect(screen.getByTestId("move-modal").textContent).toBe("acc_1@p1");
  });
});

describe("删除", () => {
  async function confirmDelete() {
    fireEvent.click(await menuItem("Delete"));
    await screen.findByText(/Delete this account\?/);
    const buttons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
  }

  it("点菜单里的「删除」只弹确认,不直接删", async () => {
    mount(row());
    fireEvent.click(await menuItem("Delete"));
    await screen.findByText(/Delete this account\?/);
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("确认框里点取消 → 收起确认框,不删", async () => {
    mount(row());
    fireEvent.click(await menuItem("Delete"));
    await screen.findByText(/Delete this account\?/);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText(/Delete this account\?/)).toBeNull());
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("确认 → 删这个账户,成功后关抽屉", async () => {
    removeAccount.mockResolvedValue(undefined);
    const { onOpenChange } = mount(row());
    await confirmDelete();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(removeAccount).toHaveBeenCalledWith({ data: { accountId: "acc_1" } });
  });

  it("删除失败 → 报错,抽屉不关", async () => {
    removeAccount.mockRejectedValue(new Error("boom"));
    const { onOpenChange } = mount(row());
    await confirmDelete();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Action failed."));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("就地改名", () => {
  async function rename(to: string) {
    fireEvent.click(screen.getByText("Main wallet"));
    const input = (await screen.findByDisplayValue("Main wallet")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: to } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
  }

  it("改名 → 写这个账户的新名字,成功后退出编辑", async () => {
    renameAccount.mockResolvedValue(undefined);
    mount(row());
    await rename("Cold storage");

    await waitFor(() =>
      expect(renameAccount).toHaveBeenCalledWith({
        data: { accountId: "acc_1", label: "Cold storage" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
  });

  it("改名失败 → 报错并停在输入框里", async () => {
    renameAccount.mockRejectedValue(new Error("boom"));
    mount(row());
    await rename("Cold storage");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Action failed."));
    expect(screen.getByDisplayValue("Cold storage")).toBeTruthy();
  });
});
