import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

// 自定义 Tab 的「选目标」选择器(ADR 0034):
//   · 三段 —— Tags(`#名`)/ Types(连接器类型名,走目录;目录里没有 → 首字母大写兜底)/
//     Accounts(`@名`);哪段没有选项哪段整段不出;三段都空 → 「Nothing to pin yet」
//   · 点一项 → 回调带回的是 {kind, 对应的那个 id},三种 kind 各自填对字段
// 连接器目录是 server fn → 打桩。

const { listConnectors } = vi.hoisted(() => ({ listConnectors: vi.fn() }));
vi.mock("@/lib/server/connectors", () => ({
  listConnectors,
  getConnectorCredentialSpecs: vi.fn(),
}));

const { TabPinPicker } = await import("@/routes/_authed/-home/tab/pin-picker");

beforeEach(() => {
  listConnectors.mockReset();
  listConnectors.mockResolvedValue({
    binance: { label: "Binance", logo: "/api/logo/platform/binance" },
  });
});
afterEach(cleanup);

function mount(props: Partial<Parameters<typeof TabPinPicker>[0]> = {}) {
  const onPick = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <TabPinPicker
          connectorOptions={[]}
          tagOptions={[]}
          accountOptions={[]}
          onPick={onPick}
          {...props}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return onPick;
}

const options = () => screen.queryAllByRole("button").map((b) => b.textContent);

describe("三段与空态", () => {
  it("三段都空 → 「Nothing to pin yet」,一个选项都没有", () => {
    mount();
    expect(screen.getByText("Nothing to pin yet")).toBeTruthy();
    expect(options()).toEqual([]);
  });

  it("有选项时不出空态;按 Tags → Types → Accounts 排,各带各的标记", async () => {
    mount({
      tagOptions: [{ id: "t1", name: "DeFi" }],
      connectorOptions: [{ id: "binance", label: "ignored" }],
      accountOptions: [{ id: "a1", label: "Cold" }],
    });
    expect(screen.queryByText("Nothing to pin yet")).toBeNull();
    expect(screen.getByText("Tags")).toBeTruthy();
    expect(screen.getByText("Types")).toBeTruthy();
    expect(screen.getByText("Accounts")).toBeTruthy();
    // 连接器名走目录(不是传进来的 label)—— 选择器里看到什么,固定后药丸就是什么。
    const binance = await screen.findByRole("button", { name: "Binance" });
    expect(screen.getAllByRole("button")).toEqual([
      screen.getByRole("button", { name: "#DeFi" }),
      binance,
      screen.getByRole("button", { name: "@Cold" }),
    ]);
  });

  it("目录里没有这个连接器 → 名字首字母大写兜底", async () => {
    listConnectors.mockResolvedValue({});
    mount({ connectorOptions: [{ id: "zerion", label: "x" }] });
    expect(await screen.findByText("Zerion")).toBeTruthy();
  });

  it("没有选项的段整段不出(连段名都没有)", () => {
    mount({ accountOptions: [{ id: "a1", label: "Cold" }] });
    expect(screen.queryByText("Tags")).toBeNull();
    expect(screen.queryByText("Types")).toBeNull();
    expect(screen.getByText("Accounts")).toBeTruthy();
  });
});

describe("点一项 → 回调带回的目标", () => {
  it("标签 → {kind: tag, tagId}", () => {
    const onPick = mount({ tagOptions: [{ id: "t1", name: "DeFi" }] });
    fireEvent.click(screen.getByRole("button", { name: "#DeFi" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "tag", tagId: "t1" });
  });

  it("账户 → {kind: account, accountId}", () => {
    const onPick = mount({ accountOptions: [{ id: "a1", label: "Cold" }] });
    fireEvent.click(screen.getByRole("button", { name: "@Cold" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "account", accountId: "a1" });
  });

  it("连接器 → {kind: connector, connectorId}", async () => {
    const onPick = mount({ connectorOptions: [{ id: "binance", label: "Binance" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Binance" }));
    expect(onPick).toHaveBeenCalledWith({ kind: "connector", connectorId: "binance" });
  });
});
