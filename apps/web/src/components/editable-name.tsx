import { Button, cn, Input, Tooltip } from "@folio/ui";
import { Pencil } from "lucide-react";
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
  tooltip = true,
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
  /** 「点击编辑」tooltip;在 overflow-hidden 容器内(如 SwipeableList 行)会被裁,可关掉。默认开。 */
  tooltip?: boolean;
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
          classNames={{ field: "h-8" }}
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

  // 点名字进入就地编辑。可发现性双轨:桌面(fine 指针)hover 弹 tooltip、藏铅笔;
  // 移动端(coarse 触屏、看不到 tooltip)常驻淡铅笔提示可编辑。
  const trigger = (
    <button
      type="button"
      onClick={() => onEditingChange(true)}
      className={cn(
        "relative block max-w-full rounded-md text-left outline-none",
        // 留位给铅笔:tooltip 关时常驻铅笔(同触屏)→ 一直留位;否则仅触屏留位。
        tooltip ? "pointer-coarse:pr-5" : "pr-5",
      )}
    >
      <span className={cn("block truncate", displayClassName)}>{value || placeholder}</span>
      {/* 铅笔收在 button 内右侧(right-0),配合上面留位 → 不伸出、不压后面的 badge。
          tooltip 关(无 hover 提示)→ 常驻淡铅笔当可编辑提示,与触屏端一致。 */}
      <Pencil
        className={cn(
          "-translate-y-1/2 pointer-events-none absolute top-1/2 right-0 size-3 text-muted-foreground",
          tooltip ? "opacity-0 pointer-coarse:opacity-50" : "opacity-50",
        )}
        aria-hidden
      />
    </button>
  );

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {/* tooltip 在 overflow-hidden 容器(如 SwipeableList 行)内会被裁 → 可由父关闭(见 tooltip prop)。 */}
      {tooltip ? (
        <Tooltip content={tc("clickToEdit")} side="top">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      {children}
    </div>
  );
}
