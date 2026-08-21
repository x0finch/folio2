import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { TagInput } from "@/components/tag-input";
import { messages } from "@/lib/i18n/messages";

// TagInput(#351):`#` 是**纯展示前缀,永不入库** —— 界面到处显 `#name`,用户顺手多敲的 `#` 在
// commit / rename 时被吞掉,回调拿到的始终是纯名字。这层约定是这组测试要锁住的东西。

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

describe("TagInput 的 # 前缀", () => {
  it("新建时吞掉用户多敲的前导 #,存纯名字", () => {
    const { container, onCreate } = renderInput();
    const input = container.querySelector("input");
    if (!input) throw new Error("no input");
    fireEvent.change(input, { target: { value: "##longterm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith("longterm");
  });

  // 粘贴常带前后空格。若先剥 `#` 再 trim,`^#+` 对 " #cold" 压根匹配不上 → `#` 跟着进库。
  it("带空格也剥得掉:前导空格、`#` 与名字之间的空格都不留", () => {
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

  it("输入带 # 时命中同名既有 Tag → 打上而非新建", () => {
    const { container, onCreate, onToggle } = renderInput({ items: [item("longterm")] });
    const input = container.querySelector("input");
    if (!input) throw new Error("no input");
    fireEvent.change(input, { target: { value: "#Longterm" } }); // 大小写不敏感
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledWith("id-longterm", true);
  });

  it("chips 显示 #name,但存的是纯名字", () => {
    const { getByText } = renderInput({ items: [item("longterm")] });
    expect(getByText("#longterm")).toBeTruthy();
  });

  it("改名同样吞 #;吞完与原名相同则不触发改名", () => {
    const { container, onRename } = renderInput({ items: [item("longterm")] });
    fireEvent.click(container.querySelectorAll("button")[0]); // Manage
    const rename = container.querySelector("input");
    if (!rename) throw new Error("no rename input");
    fireEvent.blur(rename, { target: { value: "#growth" } });
    expect(onRename).toHaveBeenCalledWith("id-longterm", "growth");

    onRename.mockClear();
    fireEvent.blur(rename, { target: { value: "#longterm" } }); // 吞完 == 原名 → no-op
    expect(onRename).not.toHaveBeenCalled();
  });
});
