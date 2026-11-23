import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { TagInput } from "@/components/tag-input";
import { messages } from "@/lib/i18n/messages";

function renderInput(props: Partial<React.ComponentProps<typeof TagInput>> = {}) {
  const onCreate = vi.fn();
  const onToggle = vi.fn();
  const onRename = vi.fn();
  const utils = render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
      <TagInput
        items={[]}
        onToggle={onToggle}
        onCreate={onCreate}
        onRename={onRename}
        onDelete={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
  return { ...utils, onCreate, onToggle, onRename };
}

const item = (name: string) => ({ id: `id-${name}`, name, attached: false, accountCount: 0 });

describe("# prefix of TagInput", () => {
  it("on create swallows an extra leading # typed by the user, stores the plain name", () => {
    const { container, onCreate } = renderInput();
    const input = container.querySelector("input");
    if (!input) throw new Error("no input");
    fireEvent.change(input, { target: { value: "##longterm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith("longterm");
  });

  it("whitespace is stripped too: leading spaces and spaces between `#` and the name are all dropped", () => {
    for (const [typed, stored] of [
      [" #cold", "cold"],
      ["#  cold ", "cold"],
      ["  ## cold  ", "cold"],
    ] as const) {
      const { container, onCreate } = renderInput();
      const input = container.querySelector("input");
      if (!input) throw new Error("no input");
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onCreate).toHaveBeenCalledWith(stored);
    }
  });

  it("input with # matching an existing tag of the same name: applies it instead of creating", () => {
    const { container, onCreate, onToggle } = renderInput({ items: [item("longterm")] });
    const input = container.querySelector("input");
    if (!input) throw new Error("no input");
    fireEvent.change(input, { target: { value: "#Longterm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledWith("id-longterm", true);
  });

  it("chips show #name, but the plain name is stored", () => {
    const { getByText } = renderInput({ items: [item("longterm")] });
    expect(getByText("#longterm")).toBeTruthy();
  });

  it("rename also swallows #; if it equals the original after swallowing, no rename is triggered", () => {
    const { container, onRename } = renderInput({ items: [item("longterm")] });
    fireEvent.click(container.querySelectorAll("button")[0]); // Manage
    const rename = container.querySelector("input");
    if (!rename) throw new Error("no rename input");
    fireEvent.blur(rename, { target: { value: "#growth" } });
    expect(onRename).toHaveBeenCalledWith("id-longterm", "growth");

    onRename.mockClear();
    fireEvent.blur(rename, { target: { value: "#longterm" } });
    expect(onRename).not.toHaveBeenCalled();
  });
});
