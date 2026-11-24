"use client";

import type { Note } from "@folio/connectors-basic";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@folio/ui";
import { useHoverPopover } from "@/lib/hooks/use-hover-popover";
import { NoteIconGlyph, NoteView } from "./note-view";

export interface NoteIndicatorProps {
  note: Note;
  // Injected locale number formatting, passed to the popover's <NoteView>.
  formatNumber?: (n: number) => string;
  className?: string;
}

// Balance-level note entry: a small status icon (not a badge); hover/focus opens a Popover with
// the note. Z-lift, goo backing and direction come from useHoverPopover (shared with LiqRing).
// The icon is wrapped in a <button> so it is focusable; aria-label carries the note title.
export function NoteIndicator({ note, formatNumber, className }: NoteIndicatorProps) {
  const pop = useHoverPopover();
  return (
    <Popover
      trigger="hover"
      side={pop.side}
      onOpenChange={pop.onOpenChange}
      className={cn("shrink-0", pop.rootClassName)}
    >
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
