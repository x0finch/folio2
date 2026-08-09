import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "../src/lib/i18n/messages";

// 估值口径开关(#428 片 1)。这张卡以前自己存一份 `sourceFirst` + `busy`,失败时手动写回;
// 现在显示值是从 mutation 推出来的:在飞时看这次点的 `variables`,落地后看服务端那份 `mode`。
//
// 换掉一段显式回滚代码,就得有东西盯着「失败会回到旧值」——否则哪天 isPending 的边界变了,
// 开关会静悄悄停在用户点的那个状态上,而服务端根本没改。这三条测的就是这个。
//
// 路由模块在**模块加载期**跑 createFileRoute + import server fn(`cloudflare:workers` 在 jsdom 下
// 解析不了),故先 mock 掉 server 那层再 import 组件 —— 与 settings-passkey-lock.test.tsx 同一套。
const { updateValuationSettings } = vi.hoisted(() => ({ updateValuationSettings: vi.fn() }));

vi.mock("../src/lib/server/settings", () => ({
  getDataStats: vi.fn(),
  getProviderKeyStatus: vi.fn(),
  getValuationSettings: vi.fn(),
  updateValuationSettings,
}));
vi.mock("../src/lib/import-data", () => ({ importData: vi.fn() }));
vi.mock("../src/lib/auth-client", () => ({
  authClient: { passkey: {} },
  signOut: vi.fn(),
  signIn: { passkey: vi.fn(), email: vi.fn() },
}));

const { ValuationCard } = await import("../src/routes/_authed/settings");

function mount(mode: "self-first" | "source-first") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <ValuationCard mode={mode} />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const box = () => utils.container.querySelector("#valuation-source-first") as HTMLElement;
  return { ...utils, box };
}

const isChecked = (el: HTMLElement) =>
  el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked === true;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("估值口径开关", () => {
  it("勾上 → 写 source-first", async () => {
    updateValuationSettings.mockResolvedValue(undefined);
    const { box } = mount("self-first");

    fireEvent.click(box());

    await waitFor(() =>
      expect(updateValuationSettings).toHaveBeenCalledWith({ data: { mode: "source-first" } }),
    );
  });

  it("取消勾选 → 写 self-first", async () => {
    updateValuationSettings.mockResolvedValue(undefined);
    const { box } = mount("source-first");

    fireEvent.click(box());

    await waitFor(() =>
      expect(updateValuationSettings).toHaveBeenCalledWith({ data: { mode: "self-first" } }),
    );
  });

  // 这一条是整份文件的理由:回滚不再是一行 setState,而是「pending 结束后显示值自然落回 mode」。
  it("写失败 → 勾选框回到原样,不停在用户点的那个状态", async () => {
    updateValuationSettings.mockRejectedValue(new Error("boom"));
    const { box } = mount("self-first");
    expect(isChecked(box())).toBe(false);

    fireEvent.click(box());

    await waitFor(() => expect(updateValuationSettings).toHaveBeenCalled());
    await waitFor(() => expect(isChecked(box())).toBe(false));
  });

  // 连点两次只发一个请求 —— 手搓 busy 时代这里是没有保护的。
  it("在飞的时候开关是禁用的,连点两次只发一次", async () => {
    let release: (() => void) | undefined;
    updateValuationSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const { box } = mount("self-first");

    fireEvent.click(box());
    await waitFor(() => expect(updateValuationSettings).toHaveBeenCalledTimes(1));
    fireEvent.click(box());
    expect(updateValuationSettings).toHaveBeenCalledTimes(1);

    // 收尾:放行后 pending 结束,显示值交回 `mode`(测里父层不换 prop,所以回到 unchecked)。
    release?.();
    await waitFor(() => expect(isChecked(box())).toBe(false));
  });
});
