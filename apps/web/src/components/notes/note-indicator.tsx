"use client";

import type { Note } from "@folio/connectors-basic";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { useHoverPopover } from "../../lib/hooks/use-hover-popover";
import { NoteIconGlyph, NoteView } from "./note-view";

export interface NoteIndicatorProps {
  note: Note;
  // 数字值 locale 格式化(app 注入),透传给 popover 里的 <NoteView>。
  formatNumber?: (n: number) => string;
  className?: string;
}

// balance 级 note 入口(note 重设计,Q2 右尺寸 / hover 触发):行内一个小状态 icon(不是 badge),
// hover/focus 开 beUI Popover 看该段(<NoteView>:段标题 + content);内容超长 → popover 内部滚动。
// 无 modal。动态方向这类调用侧行为取自 useHoverPopover(与 LiqRing 共用)。
// 触发用 <button> 包 icon(可聚焦、键盘 focus 也能开;aria-label 用段标题补足无障碍语义)。
export function NoteIndicator({ note, formatNumber, className }: NoteIndicatorProps) {
  const pop = useHoverPopover();
  return (
    <Popover trigger="hover" side={pop.side} onOpenChange={pop.onOpenChange} className="shrink-0">
      <PopoverTrigger>
        <button
          ref={pop.measureRef}
          type="button"
          aria-label={note.title}
          className={cn("inline-flex cursor-pointer items-center outline-none", className)}
        >
          <NoteIconGlyph icon={note.icon} className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="max-h-64 min-w-[10rem] overflow-y-auto text-xs">
          <NoteView note={note} formatNumber={formatNumber} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
