import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { settingsKeys } from "@/lib/queries/keys";

//
//
const { updateValuationSettings, getValuationSettings } = vi.hoisted(() => ({
  updateValuationSettings: vi.fn(),
  getValuationSettings: vi.fn(),
}));

vi.mock("@/lib/server/settings", () => ({
  getDataStats: vi.fn(),
  getProviderKeyStatus: vi.fn(),
  getValuationSettings,
  updateValuationSettings,
}));
vi.mock("@/lib/server/preferences", () => ({
  getCurrencyPreference: vi.fn(),
}));
vi.mock("@/lib/core/auth-client", () => ({
  authClient: { passkey: {} },
  signOut: vi.fn(),
  signIn: { passkey: vi.fn(), email: vi.fn() },
}));

const { ValuationCard } = await import("@/routes/_authed/-settings/valuation-card");

function mount(mode: "self-first" | "source-first") {
  getValuationSettings.mockResolvedValue({ valuationMode: mode });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(settingsKeys.valuation(), { valuationMode: mode });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <ValuationCard />
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

describe("valuation basis switch", () => {
  it("checked: writes source-first", async () => {
    updateValuationSettings.mockResolvedValue(undefined);
    const { box } = mount("self-first");

    fireEvent.click(box());

    await waitFor(() =>
      expect(updateValuationSettings).toHaveBeenCalledWith({ data: { mode: "source-first" } }),
    );
  });

  it("unchecked: writes self-first", async () => {
    updateValuationSettings.mockResolvedValue(undefined);
    const { box } = mount("source-first");

    fireEvent.click(box());

    await waitFor(() =>
      expect(updateValuationSettings).toHaveBeenCalledWith({ data: { mode: "self-first" } }),
    );
  });

  it("write fails: checkbox reverts instead of staying at the clicked state", async () => {
    updateValuationSettings.mockRejectedValue(new Error("boom"));
    const { box } = mount("self-first");
    expect(isChecked(box())).toBe(false);

    fireEvent.click(box());

    await waitFor(() => expect(updateValuationSettings).toHaveBeenCalled());
    await waitFor(() => expect(isChecked(box())).toBe(false));
  });

  it("switch is disabled while in flight; double click sends once", async () => {
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

    release?.();
    await waitFor(() => expect(isChecked(box())).toBe(false));
  });
});
