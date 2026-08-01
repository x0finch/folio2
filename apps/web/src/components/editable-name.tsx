import { Button, cn, Input, Tooltip } from "@folio/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";

// 就地(inline)名称编辑,全站统一:点名字进入编辑、hover 名字右上角浮出小铅笔角标;编辑态 Input +
// 保存 + 取消,Enter 提交、取消复原。用在账户详情头部、设置页 passkey 列表等。
//
// 受控 editing —— 编辑状态由父持有,方便父据此调整周边(展示态才显示的 badge / 操作按钮)。
// onSave 由父负责实际写入 + 失败 toast(文案是父的);onSave 抛错则保持编辑态,让用户重试。
export function EditableName({
  value,
  editing,
  onEditingChange,
  onSave,
  displayClassName,
  placeholder,
  className,
  children,
}: {
  value: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSave: (name: string) => Promise<void> | void;
  /** 名字展示字号/字重(如账户 text-lg semibold、passkey text-sm medium)。 */
  displayClassName?: string;
  placeholder?: string;
  className?: string;
  /** 展示态名字后跟随的内容(如 badge);编辑态自动隐藏。 */
  children?: ReactNode;
}) {
  const tc = useTranslations("Common");
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);

  // 每次进入编辑用最新 value 初始化草稿。
  useEffect(() => {
    if (editing) setDraft(value);
  }, [editing, value]);

  async function submit() {
    const name = draft.trim();
    if (!name || name === value) {
      onEditingChange(false); // 空 / 未改 → 直接退出,不写
      return;
    }
    setPending(true);
    try {
      await onSave(name);
      onEditingChange(false); // 成功才退出;onSave 抛错则保持编辑态重试
    } catch {
      // onSave 内部负责失败 toast,这里保持编辑态
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <form
        className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={setDraft}
          className="h-8"
        />
        <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
          {pending ? tc("verifying") : tc("save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onEditingChange(false)}>
          {tc("cancel")}
        </Button>
      </form>
    );
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {/* 点名字进入就地编辑;hover 弹 tooltip 提示(移动端无 hover → 直接点即进编辑)。 */}
      <Tooltip content={tc("clickToEdit")} side="top">
        <button
          type="button"
          onClick={() => onEditingChange(true)}
          className="block max-w-full rounded-md text-left outline-none"
        >
          <span className={cn("block truncate", displayClassName)}>{value || placeholder}</span>
        </button>
      </Tooltip>
      {children}
    </div>
  );
}
