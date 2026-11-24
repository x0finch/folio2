import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { settingsKeys } from "@/lib/queries/keys";

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
  getValuationSettings.mockImplementation(() => new Promise(() => {}));
});

describe("theme", () => {
  it('click "Dark": persists and puts dark on <html>', () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Dark" }));
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it('click "Light" again: persists and removes dark', () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Dark" }));
    fireEvent.click(screen.getByRole("tab", { name: "Light" }));
    expect(localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("language", () => {
  it("click the Chinese tab: writes the language preference", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "中" }));
    expect(localStorage.getItem("folio_locale")).toBe("zh");
  });

  it("click the current language: no write", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "EN" }));
    expect(localStorage.getItem("folio_locale")).toBeNull();
  });
});

describe("hide balances", () => {
  it("settings not loaded yet: switch disabled, clicking writes nothing", () => {
    const { hideSwitch } = mount();
    expect(hideSwitch().disabled).toBe(true);
    fireEvent.click(hideSwitch());
    expect(updatePrivacySettings).not.toHaveBeenCalled();
  });

  it("toggle on: shows on without waiting for the server, and writes hideBalances: true", async () => {
    updatePrivacySettings.mockImplementation(() => new Promise(() => {}));
    const { hideSwitch, client } = mount({ valuationMode: "self-first", hideBalances: false });
    expect(hideSwitch().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(hideSwitch());

    await waitFor(() => expect(hideSwitch().getAttribute("aria-checked")).toBe("true"));
    expect(updatePrivacySettings).toHaveBeenCalledWith({ data: { hideBalances: true } });
    expect(client.getQueryData(settingsKeys.valuation())).toEqual({
      valuationMode: "self-first",
      hideBalances: true,
    });
  });

  it("write fails: reverts to the old value and reports the error", async () => {
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
