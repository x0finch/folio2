import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { settingsKeys } from "@/lib/queries/keys";

// 设置页「外观」卡:主题 / 语言 / 隐藏余额。
// ① 主题点哪档就持久化哪档,并当场切 <html> 的 dark 类;
// ② 语言点另一种才写偏好(点当前那种不写 —— 写了会白白通知一遍所有订阅者);
// ③ 隐藏余额:设置没读到前开关禁用(不知道当前值就别让人拨);拨动**立刻**生效(乐观,
//    不等服务端),写失败要回到原值并报错 —— 否则屏幕上的「已隐藏」是假的。
const { updatePrivacySettings, getValuationSettings, toastError } = vi.hoisted(() => ({
  updatePrivacySettings: vi.fn(),
  getValuationSettings: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/server/settings", () => ({
  getDataStats: vi.fn(),
  getDataVersion: vi.fn(),
  getProviderKeyStatus: vi.fn(),
  getValuationSettings,
  updatePrivacySettings,
}));
vi.mock("@/lib/server/preferences", () => ({ getCurrencyPreference: vi.fn() }));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: vi.fn() },
}));

const { AppearanceCard } = await import("@/routes/_authed/-settings/appearance-card");

function mount(settings?: { valuationMode: string; hideBalances: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (settings) client.setQueryData(settingsKeys.valuation(), settings);
  render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <AppearanceCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const hideSwitch = () =>
    screen.getByRole("switch", { name: "Hide balances" }) as HTMLButtonElement;
  return { client, hideSwitch };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
  // 默认停在路上:要「已读到」的用例自己 setQueryData。
  getValuationSettings.mockImplementation(() => new Promise(() => {}));
});

describe("主题", () => {
  it("点「深色」→ 持久化并给 <html> 挂上 dark", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Dark" }));
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("再点「浅色」→ 持久化并摘掉 dark", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Dark" }));
    fireEvent.click(screen.getByRole("tab", { name: "Light" }));
    expect(localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("语言", () => {
  it("点「中」→ 写入语言偏好", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "中" }));
    expect(localStorage.getItem("folio_locale")).toBe("zh");
  });

  it("点当前语言 → 不写", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "EN" }));
    expect(localStorage.getItem("folio_locale")).toBeNull();
  });
});

describe("隐藏余额", () => {
  it("设置还没读到 → 开关禁用,点了也不写", () => {
    const { hideSwitch } = mount();
    expect(hideSwitch().disabled).toBe(true);
    fireEvent.click(hideSwitch());
    expect(updatePrivacySettings).not.toHaveBeenCalled();
  });

  it("拨开 → 不等服务端就显示已开,并写 hideBalances: true", async () => {
    updatePrivacySettings.mockImplementation(() => new Promise(() => {}));
    const { hideSwitch, client } = mount({ valuationMode: "self-first", hideBalances: false });
    expect(hideSwitch().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(hideSwitch());

    await waitFor(() => expect(hideSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(updatePrivacySettings).toHaveBeenCalledWith({ data: { hideBalances: true } });
    // 乐观写进的是**共享**那份 user_settings 缓存(隐私 Provider 读的同一份),其余字段原样。
    expect(client.getQueryData(settingsKeys.valuation())).toEqual({
      valuationMode: "self-first",
      hideBalances: true,
    });
  });

  it("写失败 → 回到原值并报错", async () => {
    updatePrivacySettings.mockRejectedValue(new Error("boom"));
    const { hideSwitch, client } = mount({ valuationMode: "self-first", hideBalances: true });

    fireEvent.click(hideSwitch());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't save that. Try again."));
    expect(hideSwitch().getAttribute("aria-checked")).toBe("true");
    expect(client.getQueryData(settingsKeys.valuation())).toEqual({
      valuationMode: "self-first",
      hideBalances: true,
    });
  });
});
