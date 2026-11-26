import type { Note, NoteRow } from "@folio/connectors-basic";
import { cn } from "@folio/ui";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  type Icon,
  Info,
  TriangleAlert,
} from "@folio/ui/icons";

// Renders one Note (status icon + title + content). content: string is plain text, NoteRow[] a row
// list (a row with href links out). Numbers go through the injected formatNumber; row keys are indexes (read-only list).

// Neutral status names -> icons.
const NOTE_ICON_MAP: Record<string, Icon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  help: CircleHelp,
};

// warning amber, error destructive token; others inherit muted-foreground.
const NOTE_ICON_CLASS: Record<string, string> = {
  warning: "text-warn",
  error: "text-destructive",
};

export interface NoteViewProps {
  note: Note;
  // Injected by the app (this package doesn't depend on use-intl / @folio/fx); defaults to String.
  formatNumber?: (n: number) => string;
  // Render content only, for accordion bodies whose trigger already shows icon + title.
  hideHeader?: boolean;
  className?: string;
}

// Status icon with color; `className` overrides the size (default h-4; the inline indicator uses h-3).
export function NoteIconGlyph({ icon, className }: { icon?: Note["icon"]; className?: string }) {
  const key = icon ?? "info";
  const Glyph = NOTE_ICON_MAP[key] ?? NOTE_ICON_MAP.info;
  return <Glyph className={cn("h-4 w-4 shrink-0", NOTE_ICON_CLASS[key], className)} />;
}

function RowLine({ row, formatNumber }: { row: NoteRow; formatNumber: (n: number) => string }) {
  const valueText =
    row.value == null
      ? null
      : `${typeof row.value === "number" ? formatNumber(row.value) : row.value}${
          row.unit ? ` ${row.unit}` : ""
        }`;
  const body = (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate">{row.label}</span>
      {valueText != null && (
        <span className="shrink-0 font-medium text-foreground">{valueText}</span>
      )}
    </div>
  );
  if (row.href) {
    return (
      <a
        href={row.href}
        target="_blank"
        rel="noopener noreferrer"
        className="block font-mono text-xs hover:text-foreground"
      >
        {body}
      </a>
    );
  }
  return body;
}

function NoteContent({
  content,
  formatNumber,
}: {
  content: Note["content"];
  formatNumber: (n: number) => string;
}) {
  if (typeof content === "string") return <p>{content}</p>;
  return (
    <div className="flex flex-col gap-2">
      {content.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: note rows are a static display list
        <RowLine key={i} row={row} formatNumber={formatNumber} />
      ))}
    </div>
  );
}

export function NoteView({ note, formatNumber, hideHeader, className }: NoteViewProps) {
  const fmt = formatNumber ?? ((n: number) => String(n));
  return (
    // select-text: note text (addresses, unconfirmed counts) is content, but notes often sit inside
    // cards/buttons that the base layer makes non-selectable.
    <div className={cn("flex select-text flex-col gap-2", className)}>
      {!hideHeader && (
        <div className="flex items-center gap-2">
          <NoteIconGlyph icon={note.icon} />
          <span className="text-base font-medium text-foreground">{note.title}</span>
        </div>
      )}
      <NoteContent content={note.content} formatNumber={fmt} />
    </div>
  );
}
