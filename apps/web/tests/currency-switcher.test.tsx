import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

// 展示币种切换器。钉住的是**先取汇率、再写码**这条顺序(码是外壳查询的键:先写码 → 新键没数据 →
// 整个外壳挂起成骨架闪一下),以及两条边界:
// ① 选当前币种 → 什么都不发;
// ② 服务端还没有该币汇率(回退成 USD)→ 码照样写,但要说一句,免得「点了没反应」。
const { getCurrencyPreference, toastMessage } = vi.hoisted(() => ({
  getCurrencyPreference: vi.fn(),
  toastMessage: vi.fn(),
}));

vi.mock("@/lib/server/preferences", () => ({ getCurrencyPreference }));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { message: toastMessage, error: vi.fn(), success: vi.fn() },
}));

const { CurrencySwitcher } = await import("@/components/currency-switcher");

const KEY = "folio_currency";
const cur = (code: string) => SUPPORTED_CURRENCIES.find((c) => c.code === code);
const stored = () => localStorage.getItem(KEY);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
        <CurrencySwitcher />
      </IntlProvider>
    </QueryClientProvider>,
  );
  const trigger = () => utils.container.querySelector('[aria-haspopup="listbox"]') as HTMLElement;
  const option = (code: string) =>
    [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes(`${code} ${messages.en.Currency[code as "USD"]}`),
    ) as HTMLElement;
  const pick = (code: string) => {
    fireEvent.click(trigger());
    fireEvent.click(option(code));
  };
  return { ...utils, trigger, pick };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("CurrencySwitcher", () => {
  it("触发器显示当前币种(缺省 USD)", () => {
    const { trigger } = mount();
    expect(trigger().textContent).toContain("USD Dollar");
  });

  it("选 EUR → 先取 EUR 汇率,取到后才写码;汇率有 → 不提示", async () => {
    getCurrencyPreference.mockResolvedValue({ currency: cur("EUR"), rate: 1.1 });
    const { pick } = mount();

    pick("EUR");

    await waitFor(() => expect(stored()).toBe("EUR"));
    expect(getCurrencyPreference).toHaveBeenCalledWith({ data: { code: "EUR" } });
    expect(toastMessage).not.toHaveBeenCalled();
  });

  it("汇率还没回来时,码不写(不然外壳会换到一把没数据的键上闪骨架)", async () => {
    getCurrencyPreference.mockImplementation(() => new Promise(() => {}));
    const { pick } = mount();

    pick("EUR");

    await waitFor(() => expect(getCurrencyPreference).toHaveBeenCalled());
    expect(stored()).toBeNull();
  });

  it("服务端还没有该币汇率(回退 USD)→ 码照样写,并提示一句", async () => {
    getCurrencyPreference.mockResolvedValue({ currency: cur("USD"), rate: 1 });
    const { pick } = mount();

    pick("JPY");

    await waitFor(() => expect(stored()).toBe("JPY"));
    expect(toastMessage).toHaveBeenCalledWith(
      messages.en.Currency.noRateYet.replace("{code}", "JPY"),
    );
  });

  it("选当前币种 → 不取不写", async () => {
    const { pick } = mount();
    pick("USD");
    await new Promise((r) => setTimeout(r, 0));
    expect(getCurrencyPreference).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });
});
