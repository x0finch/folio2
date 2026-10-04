import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { accountKeys, connectorKeys } from "@/lib/queries/keys";

// 加账户弹窗:两步(选类型 ↔ 填表)+ 补录凭据视图。表单本体(AccountForm / CredentialForm)
// 各有自己的测试,这里换成替身,只看弹窗**把什么交给它、它说「好了」之后弹窗做什么**:
// ① 打开 → 网格;点一个类型 → 那个类型的表单(带上它的字段规格);返回 → 回网格;
//    关了再开永远从网格起步,不停在上次的表单;
// ② 建好 → 关弹窗,后台同步**新建的那个**账户;同步失败要说出来,跳过(手记)不吵;
// ③ 补录:直接进补录视图(标题是那个 connector),交给表单的是那个账户 + 打码提示;
//    存好 → 提示「已保存,正在同步」,关补录视图,后台同步那个账户。
const { syncAccountAndWait, toastError, toastSuccess, listConnectors, getSpecs } = vi.hoisted(
  () => ({
    syncAccountAndWait: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    listConnectors: vi.fn(),
    getSpecs: vi.fn(),
  }),
);

vi.mock("@/lib/queries/account-sync", () => ({ syncAccountAndWait }));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors,
  getConnectorCredentialSpecs: getSpecs,
}));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: toastSuccess },
}));
vi.mock("@/components/account-fields", () => ({
  AccountForm: ({
    connectorId,
    specs,
    onDone,
  }: {
    connectorId: string;
    specs: { key: string }[];
    onDone: (id: string) => void;
  }) => (
    <div data-testid="account-form">
      {`form:${connectorId} specs:${specs.map((s) => s.key).join(",")}`}
      <button type="button" onClick={() => onDone("new_1")}>
        form-done
      </button>
    </div>
  ),
}));
vi.mock("@/components/credential-form", () => ({
  CredentialForm: ({
    accountId,
    specs,
    hint,
    onDone,
  }: {
    accountId: string;
    specs: { key: string }[];
    hint?: Record<string, string>;
    onDone: () => void;
  }) => (
    <div data-testid="cred-form">
      {`cred:${accountId} specs:${specs.map((s) => s.key).join(",")} hint:${JSON.stringify(hint)}`}
      <button type="button" onClick={onDone}>
        cred-done
      </button>
    </div>
  ),
}));

const { AddAccountModal } = await import("@/routes/_authed/-accounts/add-account-modal");

const SPECS = {
  binance: [{ key: "apiKey" }, { key: "apiSecret" }],
  evm: [{ key: "address" }],
};

const CATALOG = { binance: { label: "Binance" }, evm: { label: "EVM" } };

function wrap(node: React.ReactNode, catalog: object = CATALOG) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(connectorKeys.catalogue(), catalog);
  return {
    client,
    ui: (
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
          {node}
        </IntlProvider>
      </QueryClientProvider>
    ),
  };
}

// 自持模式:页面上的按钮作触发器。
function mountSelfOwned() {
  const { ui, client } = wrap(
    <AddAccountModal
      triggerRender={
        <button type="button" data-testid="trigger">
          open
        </button>
      }
    />,
  );
  return { ...render(ui), client };
}

const openModal = () => fireEvent.click(screen.getByTestId("trigger"));
// 账户页名单那份缓存:弹窗写完之后它该被标旧(下一次读就是新的),这才看得到新账户 / 新余额。
const LIST = accountKeys.list("p1");
const seedList = (client: QueryClient) => client.setQueryData(LIST, []);
const listStale = (client: QueryClient) => client.getQueryState(LIST)?.isInvalidated === true;

// 网格格子的可访问名前面还带着 logo 的首字母兜底,按名字结尾匹配。
const pick = async (label: string) =>
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`${label}$`) }));

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  getSpecs.mockResolvedValue(SPECS);
  listConnectors.mockImplementation(() => new Promise(() => {}));
});

describe("选类型 ↔ 填表", () => {
  it("打开是网格;点一个类型进它的表单,带上它的字段规格", async () => {
    mountSelfOwned();
    openModal();
    await screen.findByText("Pick a type, then fill in its details.");
    expect(screen.getByRole("heading", { name: "Add account" })).toBeTruthy();

    await pick("Binance");

    await waitFor(() =>
      expect(screen.getByTestId("account-form").textContent).toContain(
        "form:binance specs:apiKey,apiSecret",
      ),
    );
    expect(screen.getByRole("heading", { name: "Binance" })).toBeTruthy();
  });

  it("没打开时不去拉字段规格;打开才拉", async () => {
    mountSelfOwned();
    await Promise.resolve();
    expect(getSpecs).not.toHaveBeenCalled();

    openModal();

    await waitFor(() => expect(getSpecs).toHaveBeenCalled());
  });

  it("返回 → 回到网格", async () => {
    mountSelfOwned();
    openModal();
    await pick("EVM");
    await screen.findByTestId("account-form");

    fireEvent.click(screen.getByRole("button", { name: "Back to connectors" }));

    await waitFor(() => expect(screen.queryByTestId("account-form")).toBeNull());
    expect(screen.getByRole("heading", { name: "Add account" })).toBeTruthy();
  });

  it("关了再开 → 从网格起步,不停在上次的表单", async () => {
    mountSelfOwned();
    openModal();
    await pick("EVM");
    await screen.findByTestId("account-form");

    // 网格那一视图的退场动画走完之前,两个视图的头同时在 DOM 里 —— 等只剩表单那一个再点。
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Close" })));
    await waitFor(() => expect(screen.queryByTestId("account-form")).toBeNull());
    openModal();

    await screen.findByRole("heading", { name: "Add account" });
    await waitFor(() => expect(screen.queryByTestId("account-form")).toBeNull());
  });
});

describe("建好之后", () => {
  it("关弹窗,后台同步新建的那个账户", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: true });
    const onOpenChange = vi.fn();
    const { ui, client } = wrap(<AddAccountModal open onOpenChange={onOpenChange} />);
    render(ui);
    await pick("EVM");

    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalledWith(client, "new_1"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("建好 → 账户名单立刻刷新;后台同步跑完再刷一次(余额进来)", async () => {
    let finishSync: (v: unknown) => void = () => {};
    syncAccountAndWait.mockImplementation(
      () =>
        new Promise((r) => {
          finishSync = r;
        }),
    );
    const { ui, client } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    seedList(client);
    render(ui);
    await pick("EVM");

    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(listStale(client)).toBe(true));
    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalled());
    seedList(client); // 名单已按新数据读回来
    expect(listStale(client)).toBe(false);

    finishSync({ ok: true });

    await waitFor(() => expect(listStale(client)).toBe(true));
  });

  it("后台同步失败 → 把上游的原话报出来", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: false, error: "rate limited" });
    const { ui } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    render(ui);
    await pick("EVM");
    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("rate limited"));
  });

  it("后台同步失败但没有原话 → 通用失败文案", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: false });
    const { ui } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    render(ui);
    await pick("EVM");
    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Sync failed."));
  });

  it("同步被跳过(如手记账户)→ 不报错", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: false, skipped: true });
    const { ui } = wrap(<AddAccountModal open onOpenChange={vi.fn()} />);
    render(ui);
    await pick("EVM");
    fireEvent.click(await screen.findByRole("button", { name: "form-done" }));

    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalled());
    await Promise.resolve();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("补录凭据", () => {
  const target = {
    accountId: "acc_9",
    connectorId: "binance" as const,
    credsSafe: { apiKey: "ab…yz" },
  };

  it("直接进补录视图:标题是那个 connector,交给表单的是那个账户 + 打码提示", async () => {
    const { ui } = wrap(<AddAccountModal completeFor={target} onCompleteClose={vi.fn()} />);
    render(ui);

    await screen.findByText("Add your read-only API credentials to resume syncing.");
    expect(screen.getByRole("heading", { name: "Binance" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("cred-form").textContent).toContain(
        'cred:acc_9 specs:apiKey,apiSecret hint:{"apiKey":"ab…yz"}',
      ),
    );
    expect(screen.queryByRole("button", { name: "Back to connectors" })).toBeNull();
  });

  it("补录视图的标题用目录里那个 connector 的名字", async () => {
    const { ui } = wrap(<AddAccountModal completeFor={target} onCompleteClose={vi.fn()} />, {
      binance: { label: "Binance Global" },
    });
    render(ui);

    expect(await screen.findByRole("heading", { name: "Binance Global" })).toBeTruthy();
  });

  it("存好 → 提示正在同步,关补录视图,后台同步那个账户", async () => {
    syncAccountAndWait.mockResolvedValue({ ok: true });
    const onCompleteClose = vi.fn();
    const { ui, client } = wrap(
      <AddAccountModal completeFor={target} onCompleteClose={onCompleteClose} />,
    );
    seedList(client);
    render(ui);

    fireEvent.click(await screen.findByRole("button", { name: "cred-done" }));

    expect(toastSuccess).toHaveBeenCalledWith("Saved, syncing…");
    expect(onCompleteClose).toHaveBeenCalled();
    // 账户立刻翻正(不再显示缺凭据),不等同步跑完。
    expect(listStale(client)).toBe(true);
    await waitFor(() => expect(syncAccountAndWait).toHaveBeenCalledWith(client, "acc_9"));
  });

  it("关闭 → 清掉补录目标", async () => {
    const onCompleteClose = vi.fn();
    const { ui } = wrap(<AddAccountModal completeFor={target} onCompleteClose={onCompleteClose} />);
    render(ui);

    fireEvent.click(await screen.findByRole("button", { name: "Close" }));

    expect(onCompleteClose).toHaveBeenCalled();
    expect(syncAccountAndWait).not.toHaveBeenCalled();
  });
});
