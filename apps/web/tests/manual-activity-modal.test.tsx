import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PickedToken } from "../src/components/manual-activity-modal";
import { messages } from "../src/lib/i18n/messages";

// 手记活动弹窗的新接口(#428 片 3)。
//
// 它以前自己存 `busy` + `error`,`onSubmit` 是个 `Promise<{ok:boolean}>`,弹窗 `await` 它。
// 那个形状有个洞:父级那句裸 `await createManualActivities(...)` 一旦抛(网络断 / server fn 500),
// 异常穿过弹窗的 try/finally 逃出去,变成没人接的 unhandled rejection —— 按钮恢复可点,
// **画面上什么都不说**。现在提交只是「发起」,在飞与结果都由父级的 mutation 经 props 回来。
//
// 这份测的就是新接口的三条:发起、在飞禁用、两种失败文案不同。
vi.mock("../src/lib/server/tokens", () => ({ getTokenPrice: vi.fn() }));

const { ManualActivityModal } = await import("../src/components/manual-activity-modal");

const TOKEN: PickedToken = { symbol: "BTC", unitPrice: 65000, logo: undefined, ticket: undefined };

function mount(props: {
  pending?: boolean;
  submitResult?: "over" | "failed" | null;
  onSubmit?: (drafts: unknown[]) => void;
}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <ManualActivityModal
          open
          defaultToken={TOKEN}
          lockToken
          onClose={vi.fn()}
          onSubmit={onSubmit}
          pending={props.pending ?? false}
          submitResult={props.submitResult ?? null}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const submitBtn = () =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === messages.en.Activity.submit,
    ) as HTMLButtonElement;
  // 数量框是表单里唯一的 number 输入(价格已由 defaultToken.unitPrice 预填)。
  const amount = () => document.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
  return { ...utils, submitBtn, amount, onSubmit, text: () => document.body.textContent ?? "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("手记活动弹窗", () => {
  it("填好数量点提交 → 只发起,不等待", async () => {
    const onSubmit = vi.fn();
    const { submitBtn, amount } = mount({ onSubmit });

    fireEvent.change(amount(), { target: { value: "1.5" } });
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
    fireEvent.click(submitBtn());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0][0]).toMatchObject({ kind: "set", amount: 1.5 });
  });

  it("pending 期间提交钮禁用,点不动", async () => {
    const onSubmit = vi.fn();
    const { submitBtn, amount } = mount({ pending: true, onSubmit });

    fireEvent.change(amount(), { target: { value: "1.5" } });
    expect(submitBtn().disabled).toBe(true);
    fireEvent.click(submitBtn());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // 这一条是这次接口改动的重点:卖超和写失败以前都只有一句 reduceTooMuch,
  // 于是网络挂了也会显示「某笔减仓超过了持有量」—— 一句与事实无关、还让人去改数字的提示。
  it("卖超与写失败给的是两句不同的话", () => {
    const over = mount({ submitResult: "over" });
    expect(over.text()).toContain(messages.en.Activity.reduceTooMuch);
    expect(over.text()).not.toContain(messages.en.Accounts.actionFailed);
    over.unmount();
    document.body.innerHTML = "";

    const failed = mount({ submitResult: "failed" });
    expect(failed.text()).toContain(messages.en.Accounts.actionFailed);
    expect(failed.text()).not.toContain(messages.en.Activity.reduceTooMuch);
  });

  it("没有结果时不显示任何红字", () => {
    const { text } = mount({});
    expect(text()).not.toContain(messages.en.Activity.reduceTooMuch);
    expect(text()).not.toContain(messages.en.Accounts.actionFailed);
  });
});
