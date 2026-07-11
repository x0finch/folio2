"use client";

import type { Note } from "@folio/connectors-basic";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { useState } from "react";
import { NoteIconGlyph, NoteView } from "./note-view";

export interface NoteIndicatorProps {
  note: Note;
  // 数字值 locale 格式化(app 注入),透传给 popover 里的 <NoteView>。
  formatNumber?: (n: number) => string;
  className?: string;
}

// balance 级 note 入口(note 重设计,Q2 右尺寸 / hover 触发):行内一个小状态 icon(不是 badge),
// hover 开 beUI Popover 看该段(<NoteView>:段标题 + content);内容超长 → popover 内部滚动。无 modal。
// 打开时给 Popover root 抬 z-50:beUI popover 面板是 root 内绝对定位、不 portal —— 不抬则被后续不透明
// 兄弟行盖住。触发用 <button> 包 icon(可聚焦、键盘 focus 也能开;aria-label 用段标题补足无障碍语义)。
export function NoteIndicator({ note, formatNumber, className }: NoteIndicatorProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover trigger="hover" onOpenChange={setOpen} className={cn("shrink-0", open && "z-50")}>
      <PopoverTrigger>
        <button
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
