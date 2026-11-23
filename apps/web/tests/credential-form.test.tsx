import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";
import type { InputSpec } from "@/lib/server/creds";

// Add-credentials form. Busy and error state live in the mutation. The submit button must be disabled in
// flight (replaceAccountCredentials validates and writes, so a double submit is not harmless), and the
// semi-mismatch early return must reset the mutation, or the last failure stays shown next to "confirm".
// No jest-dom here: assertions use the plain DOM (`toBeDisabled` is an invalid Chai property).
const { replaceAccountCredentials } = vi.hoisted(() => ({ replaceAccountCredentials: vi.fn() }));

vi.mock("@/lib/server/accounts", () => ({
  replaceAccountCredentials,
  createAccount: vi.fn(),
}));
vi.mock("@/lib/server/tokens", () => ({ getTokenPrice: vi.fn() }));

const { CredentialForm } = await import("@/components/credential-form");

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
  // Fields are required; jsdom won't submit empty ones, so each test fills both.
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

describe("add-credentials form", () => {
  it("submit → writes creds, then onDone", async () => {
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

  it("button disabled in flight; a double click sends once", async () => {
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

  it("failure → shows the upstream reason verbatim, not a generic error", async () => {
    replaceAccountCredentials.mockRejectedValue(new Error("API key rejected by upstream"));
    const { submit, fill, text } = mount();
    fill();

    fireEvent.click(submit());

    await waitFor(() => expect(text()).toContain("API key rejected by upstream"));
  });

  it("mismatch with the masked hint → asks to confirm; confirming sends, and the last failure is cleared", async () => {
    replaceAccountCredentials.mockRejectedValueOnce(new Error("boom"));
    // The hint has maskCredential's shape; the value filled below doesn't match it → blocked once.
    const { submit, fill, text } = mount({ apiKey: "abcd…wxyz" });

    // Round 1: a value that passes the check → sent, fails, error shown.
    fill("abcd0000wxyz");
    fireEvent.click(submit());
    await waitFor(() => expect(text()).toContain("boom"));

    // Round 2: a mismatching value → blocked for confirmation, nothing sent, last error cleared.
    replaceAccountCredentials.mockResolvedValue(undefined);
    fill("0000totally-different0000");
    fireEvent.click(submit());
    await waitFor(() => expect(text()).toContain(messages.en.Accounts.credMismatch));
    // Assert after the await: mutationFn runs a microtask later, so a synchronous assertion could never fail.
    expect(replaceAccountCredentials).toHaveBeenCalledTimes(1); // still just round 1
    expect(text()).not.toContain("boom");

    // Clicking again = user confirms → now it sends.
    fireEvent.click(submit());
    await waitFor(() => expect(replaceAccountCredentials).toHaveBeenCalledTimes(2));
  });
});
