import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { EditableName } from "@/components/editable-name";
import { messages } from "@/lib/i18n/messages";

// Inline rename: empty or unchanged → exit without writing; changed → onSave with the trimmed name, exit
// on success; onSave throws → stay in edit mode with the draft (the parent toasts the failure).
const tc = messages.en.Common;

function Harness({
  value = "Old name",
  onSave,
  initialEditing = false,
  tooltip = false,
}: {
  value?: string;
  onSave: (name: string) => Promise<void> | void;
  initialEditing?: boolean;
  tooltip?: boolean;
}) {
  const [editing, setEditing] = useState(initialEditing);
  return (
    <EditableName
      value={value}
      editing={editing}
      onEditingChange={setEditing}
      onSave={onSave}
      tooltip={tooltip}
    />
  );
}

function mount(props: Parameters<typeof Harness>[0]) {
  const utils = render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC">
      <Harness {...props} />
    </IntlProvider>,
  );
  const input = () => utils.container.querySelector("input") as HTMLInputElement | null;
  const button = (label: string) =>
    [...utils.container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement;
  return { ...utils, input, button };
}

describe("EditableName", () => {
  it("clicking the name enters edit mode with the current name as draft", () => {
    const { getByText, input } = mount({ onSave: vi.fn() });
    expect(input()).toBeNull();
    fireEvent.click(getByText("Old name"));
    expect(input()?.value).toBe("Old name");
  });

  it("the default tooltip variant also enters edit mode on click", () => {
    const { getByText, input } = mount({ onSave: vi.fn(), tooltip: true });
    fireEvent.click(getByText("Old name"));
    expect(input()?.value).toBe("Old name");
  });

  it("save after rename → onSave with the trimmed name, exits on success", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { input, button } = mount({ onSave, initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: "  New name  " } });
    fireEvent.click(button(tc.save));
    expect(onSave).toHaveBeenCalledWith("New name");
    await waitFor(() => expect(input()).toBeNull());
  });

  it("save unchanged (or whitespace only) → no write, just exits", async () => {
    const onSave = vi.fn();
    const { input, button } = mount({ onSave, initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: " Old name " } });
    fireEvent.click(button(tc.save));
    await waitFor(() => expect(input()).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("cleared → save button disabled", () => {
    const { input, button } = mount({ onSave: vi.fn(), initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: "   " } });
    expect(button(tc.save).disabled).toBe(true);
  });

  it("onSave throws → stays in edit mode, draft kept for retry", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("boom"));
    const { input, button } = mount({ onSave, initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: "New name" } });
    fireEvent.click(button(tc.save));
    await waitFor(() => expect(button(tc.save).disabled).toBe(false));
    expect(input()?.value).toBe("New name");
  });

  it("cancel → exits without writing; reopening drafts the current name, not the unsaved one", () => {
    const onSave = vi.fn();
    const { input, button, getByText } = mount({ onSave, initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: "New name" } });
    fireEvent.click(button(tc.cancel));
    expect(input()).toBeNull();
    expect(getByText("Old name")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(getByText("Old name"));
    expect(input()?.value).toBe("Old name");
  });
});
