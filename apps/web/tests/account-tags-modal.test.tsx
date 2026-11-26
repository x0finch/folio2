import type { Tag } from "@folio/db";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "@/lib/i18n/messages";

// Optimistic layer of the tag modal: what matters is when the optimistic update lands and whether a failure
// rolls it back. Create-ok-but-attach-failed must undo both the placeholder and the optimistic attach.
const { attachTag, detachTag, createTag, renameTag, deleteTag, toastError } = vi.hoisted(() => ({
  attachTag: vi.fn(),
  detachTag: vi.fn(),
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/server/tags", () => ({
  attachTag,
  detachTag,
  createTag,
  renameTag,
  deleteTag,
}));
vi.mock("@folio/ui", async (orig) => ({
  ...(await orig<object>()),
  toast: { error: toastError, success: vi.fn() },
}));

const { AccountTagsModal } = await import("@/components/account-tags-modal");

const tag = (id: string, name: string): Tag =>
  ({ id, name, portfolioId: "p1", createdAt: 0 }) as unknown as Tag;

const TAGS = [tag("t1", "longterm"), tag("t2", "cold")];

function mount(attachedTagIds: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
        <AccountTagsModal
          accountId="a1"
          portfolioId="p1"
          portfolioTags={TAGS}
          attachedTagIds={attachedTagIds}
          tagAccountCounts={{ t1: 1, t2: 1 }}
          open
          onClose={vi.fn()}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
  // A chip's "attached" state is its aria-pressed (see TagInput).
  const chip = (name: string) =>
    [...document.querySelectorAll("[aria-pressed]")].find((e) =>
      e.textContent?.includes(`#${name}`),
    ) as HTMLElement | undefined;
  const attached = (name: string) => chip(name)?.getAttribute("aria-pressed") === "true";
  const input = () => document.querySelector("input") as HTMLInputElement;
  const names = () =>
    [...document.querySelectorAll("[aria-pressed]")].map((e) => e.textContent?.trim() ?? "");
  return { ...utils, chip, attached, input, names };
}

// Never resolves: freezes the "server hasn't answered yet" moment.
const neverResolves = () => new Promise(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("tag modal optimistic layer", () => {
  it("a click attaches immediately — without waiting for the server", async () => {
    attachTag.mockImplementation(neverResolves);
    const { chip, attached } = mount([]);
    expect(attached("longterm")).toBe(false);

    fireEvent.click(chip("longterm") as HTMLElement);

    // Must be synchronous (onMutate runs before the first await); awaiting would only prove "eventually".
    expect(attached("longterm")).toBe(true);
    // The server fn fires a microtask after onMutate, so wait for it.
    await waitFor(() =>
      expect(attachTag).toHaveBeenCalledWith({ data: { accountId: "a1", tagId: "t1" } }),
    );
  });

  it("detach likewise: unattached right after the click", async () => {
    detachTag.mockImplementation(neverResolves);
    const { chip, attached } = mount(["t1"]);
    expect(attached("longterm")).toBe(true);

    fireEvent.click(chip("longterm") as HTMLElement);

    expect(attached("longterm")).toBe(false);
    await waitFor(() => expect(detachTag).toHaveBeenCalled());
  });

  it("attach failure → the chip reverts and an error is toasted", async () => {
    attachTag.mockRejectedValue(new Error("boom"));
    const { chip, attached } = mount([]);

    fireEvent.click(chip("longterm") as HTMLElement);
    expect(attached("longterm")).toBe(true); // optimistic first

    await waitFor(() => expect(attached("longterm")).toBe(false)); // then rolled back
    expect(toastError).toHaveBeenCalled();
  });

  it("create: Enter places a selected placeholder chip right away", async () => {
    createTag.mockImplementation(neverResolves);
    const { input, names } = mount([]);

    fireEvent.change(input(), { target: { value: "newtag" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(names().some((n) => n.includes("#newtag"))).toBe(true);
    await waitFor(() =>
      expect(createTag).toHaveBeenCalledWith({ data: { portfolioId: "p1", name: "newtag" } }),
    );
  });

  it("create failure → placeholder removed", async () => {
    createTag.mockRejectedValue(new Error("boom"));
    const { input, names } = mount([]);

    fireEvent.change(input(), { target: { value: "newtag" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(names().some((n) => n.includes("#newtag"))).toBe(true);

    await waitFor(() => expect(names().some((n) => n.includes("#newtag"))).toBe(false));
    expect(toastError).toHaveBeenCalled();
  });

  it("create ok but attach fails → placeholder and optimistic attach both undone (no fake attached)", async () => {
    createTag.mockResolvedValue({ id: "t3", name: "newtag" });
    attachTag.mockRejectedValue(new Error("boom"));
    const { input, names, attached } = mount([]);

    fireEvent.change(input(), { target: { value: "newtag" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Placeholder gone, back to the two existing tags, none showing as attached.
    expect(names().some((n) => n.includes("#newtag"))).toBe(false);
    expect(attached("longterm")).toBe(false);
    expect(attached("cold")).toBe(false);
  });

  it("delete: gone from the list right after confirm; restored on failure", async () => {
    deleteTag.mockRejectedValue(new Error("boom"));
    const { getByText } = mount([]);

    // Delete lives on the manage view: switch, click the row's trash, then confirm.
    fireEvent.click(getByText(messages.en.Tags.manage));
    // Each manage row is a rename input; a row exists iff its value does.
    const rowNames = () =>
      [...document.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value);
    expect(rowNames()).toContain("cold");

    const trash = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === `${messages.en.Common.delete} cold`,
    );
    if (!trash) throw new Error("delete button for #cold not found");
    fireEvent.click(trash); // enter confirmation (the row becomes a confirm bar, no input)
    const confirm = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === messages.en.Common.delete,
    );
    if (!confirm) throw new Error("confirm button not found");

    fireEvent.click(confirm);
    expect(rowNames()).not.toContain("cold"); // gone immediately

    await waitFor(() => expect(rowNames()).toContain("cold")); // failure → restored
    expect(toastError).toHaveBeenCalled();
  });
});
