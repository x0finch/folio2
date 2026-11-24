import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

// Rates are fetched before the code is written: the code keys the shell query, so writing it first suspends
// the whole shell into a skeleton flash. Picking the current currency sends nothing; a missing rate
// (USD fallback) still writes the code but says so, so the click doesn't look ignored.
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
  it("trigger shows the current currency (USD by default)", () => {
    const { trigger } = mount();
    expect(trigger().textContent).toContain("USD Dollar");
  });

  it("pick EUR → fetches the EUR rate first, writes the code after; rate present → no toast", async () => {
    getCurrencyPreference.mockResolvedValue({ currency: cur("EUR"), rate: 1.1 });
    const { pick } = mount();

    pick("EUR");

    await waitFor(() => expect(stored()).toBe("EUR"));
    expect(getCurrencyPreference).toHaveBeenCalledWith({ data: { code: "EUR" } });
    expect(toastMessage).not.toHaveBeenCalled();
  });

  it("code not written until the rate returns (else the shell flashes a skeleton on an empty key)", async () => {
    getCurrencyPreference.mockImplementation(() => new Promise(() => {}));
    const { pick } = mount();

    pick("EUR");

    await waitFor(() => expect(getCurrencyPreference).toHaveBeenCalled());
    expect(stored()).toBeNull();
  });

  it("server has no rate for it (USD fallback) → code still written, with a toast", async () => {
    getCurrencyPreference.mockResolvedValue({ currency: cur("USD"), rate: 1 });
    const { pick } = mount();

    pick("JPY");

    await waitFor(() => expect(stored()).toBe("JPY"));
    expect(toastMessage).toHaveBeenCalledWith(
      messages.en.Currency.noRateYet.replace("{code}", "JPY"),
    );
  });

  it("picking the current currency → no fetch, no write", async () => {
    const { pick } = mount();
    pick("USD");
    await new Promise((r) => setTimeout(r, 0));
    expect(getCurrencyPreference).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });
});
