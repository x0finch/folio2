import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InputSpec } from "../src/lib/core/creds";
import { messages } from "../src/lib/i18n/messages";

// 补录凭据表单(#428 片 1)。原先它自己存 `busy` + `error`,现在两者都由 mutation 持有。
//
// 值得钉住的两条:
// ① 提交在飞的时候按钮禁用 —— 手搓 busy 版本里连点两次会发两个 `replaceAccountCredentials`,
//    而那是个**校验 + 写库**的调用,重复发不是「多花一次网络」这么轻。
// ② semi 字段与打码片段对不上 → 先拦一次要用户确认;走这条早退路径要顺手 `save.reset()`,
//    否则「请确认」旁边一直挂着上一轮的失败红字,读起来像这次就失败了。
//
// (本仓没装 jest-dom,断言一律走原生 DOM —— `toBeDisabled` 之类在这里是 Invalid Chai property。)
const { replaceAccountCredentials } = vi.hoisted(() => ({ replaceAccountCredentials: vi.fn() }));

vi.mock("../src/lib/server/accounts", () => ({
  replaceAccountCredentials,
  createAccount: vi.fn(),
}));
vi.mock("../src/lib/server/tokens", () => ({ getTokenPrice: vi.fn() }));

const { CredentialForm } = await import("../src/components/credential-form");

const SPECS: InputSpec[] = [
  { key: "apiKey", type: "semi", label: "API key" },
  { key: "apiSecret", type: "secret", label: "API secret" },
];

function mount(hint?: Record<string, string>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDone = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <CredentialForm accountId="acc_1" specs={SPECS} hint={hint} onDone={onDone} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const field = (key: string) =>
    utils.container.querySelector(`#cred-acc_1-${key}`) as HTMLInputElement;
  const submit = () => utils.container.querySelector('button[type="submit"]') as HTMLButtonElement;
  // 字段是 required 的,不填 jsdom 直接不提交 —— 每条用例先把两格填上。
  const fill = (apiKey = "keykeykeykey") => {
    fireEvent.change(field("apiKey"), { target: { value: apiKey } });
    fireEvent.change(field("apiSecret"), { target: { value: "secretsecret" } });
  };
  const text = () => utils.container.textContent ?? "";
  return { ...utils, field, submit, fill, text, onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("补录凭据表单", () => {
  it("提交 → 写凭据,成功走 onDone", async () => {
    replaceAccountCredentials.mockResolvedValue(undefined);
    const { submit, fill, onDone } = mount();
    fill();

    fireEvent.click(submit());

    await waitFor(() =>
      expect(replaceAccountCredentials).toHaveBeenCalledWith({
        data: { accountId: "acc_1", creds: { apiKey: "keykeykeykey", apiSecret: "secretsecret" } },
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("在飞的时候按钮禁用,连点两次只发一次", async () => {
    let release: (() => void) | undefined;
    replaceAccountCredentials.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const { submit, fill } = mount();
    fill();

    fireEvent.click(submit());
    await waitFor(() => expect(submit().disabled).toBe(true));
    fireEvent.click(submit());
    expect(replaceAccountCredentials).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(submit().disabled).toBe(false));
  });

  it("失败 → 原样显示上游给的原因,不压成一句通用错误", async () => {
    replaceAccountCredentials.mockRejectedValue(new Error("API key rejected by upstream"));
    const { submit, fill, text } = mount();
    fill();

    fireEvent.click(submit());

    await waitFor(() => expect(text()).toContain("API key rejected by upstream"));
  });

  it("与打码片段对不上 → 先要确认;确认后发请求,且上一轮的失败红字已清掉", async () => {
    replaceAccountCredentials.mockRejectedValueOnce(new Error("boom"));
    // hint 是 maskCredential 的产物形状,下面填的值和它对不上 → 会被拦一次。
    const { submit, fill, text } = mount({ apiKey: "abcd…wxyz" });

    // 第一轮:填一个能过校验的值,提交 → 真发,失败,红字挂上。
    fill("abcd0000wxyz");
    fireEvent.click(submit());
    await waitFor(() => expect(text()).toContain("boom"));

    // 第二轮:换成和片段对不上的值 → 被拦下要确认,没发请求,上一轮红字消失。
    replaceAccountCredentials.mockResolvedValue(undefined);
    fill("0000totally-different0000");
    fireEvent.click(submit());
    await waitFor(() => expect(text()).toContain(messages.en.Accounts.credMismatch));
    // 断言放在 await 之后:`mutationFn` 要等一个微任务才跑,紧贴 click 的同步断言
    // 就算拦截逻辑坏了也照样读到 1 —— 那种断言不可能失败,等于没写。
    expect(replaceAccountCredentials).toHaveBeenCalledTimes(1); // 仍是第一轮那次
    expect(text()).not.toContain("boom");

    // 再点一次 = 用户确认 → 这次才真发。
    fireEvent.click(submit());
    await waitFor(() => expect(replaceAccountCredentials).toHaveBeenCalledTimes(2));
  });
});
