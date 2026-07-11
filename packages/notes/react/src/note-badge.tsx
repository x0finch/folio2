"use client";

import type { Note } from "@folio/connectors-basic";
import { AnimatedBadge, cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { NoteView } from "./note-view";

// balance 级 note 的 NoteIcon → AnimatedBadge status(配色 + 状态图标)。error→danger、help→neutral,其余同名。
const BADGE_STATUS: Record<string, "info" | "success" | "warning" | "danger" | "neutral"> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "danger",
  help: "neutral",
};

export interface NoteBadgeProps {
  note: Note;
  // 数字值 locale 格式化(app 注入),透传给 popover 里的 <NoteView>。
  formatNumber?: (n: number) => string;
  className?: string;
}

// balance 级 note 入口(note 重设计,Q2 右尺寸 / hover 触发):一个 sm badge(段 icon + 标题),hover 开
// beUI Popover 看该段内容(<NoteView>);内容超长 → popover 内部滚动(max-h + overflow-y)。无 modal。
// hover:beUI 的 hover popover 面板在 root 悬停区内,移进面板不关、可正常滚动。触发用 <button> 包 badge
//(可聚焦、键盘 focus 也能开;PopoverTrigger 克隆它挂 onFocus/onBlur/ref/aria)。
export function NoteBadge({ note, formatNumber, className }: NoteBadgeProps) {
  const status = BADGE_STATUS[note.icon ?? "info"] ?? "info";
  return (
    <Popover trigger="hover">
      <PopoverTrigger>
        <button type="button" className={cn("inline-flex cursor-pointer outline-none", className)}>
          <AnimatedBadge size="sm" status={status}>
            {note.title}
          </AnimatedBadge>
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="max-h-64 min-w-[11rem] overflow-y-auto">
          <NoteView note={note} formatNumber={formatNumber} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
