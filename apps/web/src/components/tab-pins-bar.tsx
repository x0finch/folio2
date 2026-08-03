import type { TabPin } from "@folio/db";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useHoverPopover } from "../lib/hooks/use-hover-popover";
import { tagColor } from "../lib/tag-color";
import { type PinTargetChoice, TabPinPicker } from "./tab-pin-picker";

// 首页自定义 Tab 栏(ADR 0034):[总览] + ≤3 个 pin + [＋]。选中 pin → 上层用 section list 渲染;总览 → 现有子 Tab。
// 每个 pin hover 冒 popover(改指向 / 取消固定,取消固定不二次确认 —— 只删指针);＋ 与「改指向」共用内联选择器。
// 纯展示 + 本地 UI 态(哪个选择器开着);增删改由 props 回调(上层发 server fn + invalidate)。

const MAX_PINS = 3;

export function TabPinsBar({
  pins,
  activePinId,
  onSelect,
  connectorLabel,
  tagName,
  connectorOptions,
  tagOptions,
  onAdd,
  onEdit,
  onUnpin,
}: {
  pins: TabPin[];
  activePinId: string | null;
  onSelect: (pinId: string | null) => void;
  connectorLabel: (id: string) => string;
  tagName: (tagId: string) => string;
  connectorOptions: { id: string; label: string }[];
  tagOptions: { id: string; name: string }[];
  onAdd: (choice: PinTargetChoice) => void;
  onEdit: (pinId: string, choice: PinTargetChoice) => void;
  onUnpin: (pinId: string) => void;
}) {
  const t = useTranslations("CustomTabs");
  // 内联选择器:null 关;{mode:"add"} 加新;{mode:"edit",pinId} 改指向。
  const [picker, setPicker] = useState<{ mode: "add" } | { mode: "edit"; pinId: string } | null>(
    null,
  );

  const tabClass = (active: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors",
      active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
    );

  const pick = (choice: PinTargetChoice) => {
    if (picker?.mode === "edit") onEdit(picker.pinId, choice);
    else onAdd(choice);
    setPicker(null);
  };

  return (
    <div className="relative flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={tabClass(activePinId === null)}
        >
          {t("overview")}
        </button>

        {pins.map((pin) => (
          <PinTab
            key={pin.id}
            active={activePinId === pin.id}
            label={
              pin.kind === "tag" ? tagName(pin.tagId ?? "") : connectorLabel(pin.connectorId ?? "")
            }
            dotColor={pin.kind === "tag" ? tagColor(pin.tagId ?? "") : undefined}
            onSelect={() => onSelect(pin.id)}
            onEditStart={() => setPicker({ mode: "edit", pinId: pin.id })}
            onUnpin={() => {
              if (activePinId === pin.id) onSelect(null); // 取消固定当前激活的 → 回总览
              onUnpin(pin.id);
            }}
            tabClass={tabClass}
          />
        ))}

        {pins.length < MAX_PINS && (
          <button
            type="button"
            aria-label={t("add")}
            onClick={() => setPicker((p) => (p?.mode === "add" ? null : { mode: "add" }))}
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>

      {picker && (
        <div className="absolute top-full left-0 z-20 mt-1">
          <TabPinPicker connectorOptions={connectorOptions} tagOptions={tagOptions} onPick={pick} />
        </div>
      )}
    </div>
  );
}

// 单个 pin:hover 冒管理 popover(改指向 / 取消固定)。每个实例各调一次 useHoverPopover(不能在循环里调 hook,
// 故抽成子组件)。pin 按钮本身 = 选中入口(onClick),悬停 = 管理(与 account-detail-sheet ⋯ 菜单同款)。
function PinTab({
  active,
  label,
  dotColor,
  onSelect,
  onEditStart,
  onUnpin,
  tabClass,
}: {
  active: boolean;
  label: string;
  dotColor?: string;
  onSelect: () => void;
  onEditStart: () => void;
  onUnpin: () => void;
  tabClass: (active: boolean) => string;
}) {
  const t = useTranslations("CustomTabs");
  const pop = useHoverPopover();
  return (
    <Popover
      trigger="hover"
      side={pop.side}
      align="center"
      panelRadius={12}
      onOpenChange={pop.onOpenChange}
      className={pop.rootClassName}
    >
      <PopoverTrigger>
        <button ref={pop.measureRef} type="button" onClick={onSelect} className={tabClass(active)}>
          {dotColor && (
            <span className="size-2 shrink-0 rounded-full" style={{ background: dotColor }} />
          )}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex w-32 flex-col gap-0.5">
          <button
            type="button"
            onClick={onEditStart}
            className="rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
          >
            {t("changeTarget")}
          </button>
          <button
            type="button"
            onClick={onUnpin}
            className="rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
          >
            {t("unpin")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
