import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { EditableName } from "@/components/editable-name";
import { messages } from "@/lib/i18n/messages";

// 就地改名(账户详情头部、passkey 列表、组合管理共用)。钉住三条「写不写」的判据:
// ① 空 / 没改 → 直接退出编辑,**不发写**(否则每次点开再点保存都白写一次库);
// ② 改了 → 以去掉首尾空白的名字调 onSave,成功才退出编辑;
// ③ onSave 抛错 → 留在编辑态、草稿还在,让用户就地重试(失败 toast 归父级)。
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
  it("点名字进入编辑态,草稿是当前名字", () => {
    const { getByText, input } = mount({ onSave: vi.fn() });
    expect(input()).toBeNull();
    fireEvent.click(getByText("Old name"));
    expect(input()?.value).toBe("Old name");
  });

  it("带 tooltip 的默认形态同样点名字就进编辑", () => {
    const { getByText, input } = mount({ onSave: vi.fn(), tooltip: true });
    fireEvent.click(getByText("Old name"));
    expect(input()?.value).toBe("Old name");
  });

  it("改名后保存 → 以 trim 过的名字调 onSave,成功后退出编辑", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { input, button } = mount({ onSave, initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: "  New name  " } });
    fireEvent.click(button(tc.save));
    expect(onSave).toHaveBeenCalledWith("New name");
    await waitFor(() => expect(input()).toBeNull());
  });

  it("没改(或只加了空白)就保存 → 不写,直接退出", async () => {
    const onSave = vi.fn();
    const { input, button } = mount({ onSave, initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: " Old name " } });
    fireEvent.click(button(tc.save));
    await waitFor(() => expect(input()).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("清空 → 保存钮禁用", () => {
    const { input, button } = mount({ onSave: vi.fn(), initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: "   " } });
    expect(button(tc.save).disabled).toBe(true);
  });

  it("onSave 抛错 → 留在编辑态,草稿保留以便重试", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("boom"));
    const { input, button } = mount({ onSave, initialEditing: true });
    fireEvent.change(input() as HTMLInputElement, { target: { value: "New name" } });
    fireEvent.click(button(tc.save));
    await waitFor(() => expect(button(tc.save).disabled).toBe(false));
    expect(input()?.value).toBe("New name");
  });

  it("取消 → 退出编辑,不写;再次进入时草稿是当前名字而不是上次没存的那份", () => {
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
