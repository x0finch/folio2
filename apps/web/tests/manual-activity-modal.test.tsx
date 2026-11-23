import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PickedToken } from "@/components/manual-activity-modal";
import { messages } from "@/lib/i18n/messages";

// Submit only initiates: in-flight state and the outcome come back from the parent's mutation via
// props, so a throwing server fn can no longer escape as an unhandled rejection with no message.
vi.mock("@/lib/server/tokens", () => ({ getTokenPrice: vi.fn() }));

const { ManualActivityModal } = await import("@/components/manual-activity-modal");

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
  const amount = () => document.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
  return { ...utils, submitBtn, amount, onSubmit, text: () => document.body.textContent ?? "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("Manual activity modal", () => {
  it("fill in amount and submit -> fires once, does not await", async () => {
    const onSubmit = vi.fn();
    const { submitBtn, amount } = mount({ onSubmit });

    fireEvent.change(amount(), { target: { value: "1.5" } });
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
    fireEvent.click(submitBtn());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0][0]).toMatchObject({ kind: "set", amount: 1.5 });
  });

  it("submit button disabled while pending", async () => {
    const onSubmit = vi.fn();
    const { submitBtn, amount } = mount({ pending: true, onSubmit });

    fireEvent.change(amount(), { target: { value: "1.5" } });
    expect(submitBtn().disabled).toBe(true);
    fireEvent.click(submitBtn());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("oversold and write failure show different messages", () => {
    const over = mount({ submitResult: "over" });
    expect(over.text()).toContain(messages.en.Activity.reduceTooMuch);
    expect(over.text()).not.toContain(messages.en.Accounts.actionFailed);
    over.unmount();
    document.body.innerHTML = "";

    const failed = mount({ submitResult: "failed" });
    expect(failed.text()).toContain(messages.en.Accounts.actionFailed);
    expect(failed.text()).not.toContain(messages.en.Activity.reduceTooMuch);
  });

  it("no outcome -> no error text", () => {
    const { text } = mount({});
    expect(text()).not.toContain(messages.en.Activity.reduceTooMuch);
    expect(text()).not.toContain(messages.en.Accounts.actionFailed);
  });
});
