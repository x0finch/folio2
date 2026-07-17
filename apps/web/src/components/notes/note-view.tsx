import type { Note, NoteRow } from "@folio/connectors-basic";
import { cn } from "@folio/ui";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Info,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";

// 单个 Note 渲染器(note 重设计):把一个 Note(段首状态 icon + 标题 + content)渲染成一块内容。
// 复用两处:① account 级手风琴每个 item 的展开体(app 遍历 Note[],每段一 item,item 体 = <NoteView>);
// ② balance 级 <NoteIndicator> 的 popover 内容。content:string → 纯文本、NoteRow[] → 行列表;行有 href 则整行包外链。
// 数字值经注入的 formatNumber(locale)格式化;label/title 英文字面。React key(行)一律 index(只读展示列表)。

// 5 个中性状态名 → lucide 命名图标。lucide 已把 AlertTriangle/AlertCircle 改名 TriangleAlert/CircleAlert。
export const NOTE_ICON_MAP: Record<string, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  help: CircleHelp,
};

// 状态图标配色:warning 琥珀、error 用 destructive token;其余走默认(继承 muted-foreground)。
export const NOTE_ICON_CLASS: Record<string, string> = {
  warning: "text-amber-500",
  error: "text-destructive",
};

export interface NoteViewProps {
  note: Note;
  // 数字值 locale 格式化(app 注入;通用包不依赖 use-intl / @folio/fx)。缺省 String 化,安全退化。
  formatNumber?: (n: number) => string;
  // 隐藏段首(icon + 标题)只渲染 content —— 用于 account 手风琴 item 展开体(item 触发区已显 icon+标题,免重复)。
  hideHeader?: boolean;
  className?: string;
}

// 单个 NoteIcon → lucide 状态图标(含配色)。给 account 手风琴 item.icon / NoteView 段首 / NoteIndicator
// 触发共用;className 可覆盖尺寸(默认 h-4;balance 行内指示器传更小的 h-3)。
export function NoteIconGlyph({ icon, className }: { icon?: Note["icon"]; className?: string }) {
  const key = icon ?? "info";
  const Icon = NOTE_ICON_MAP[key] ?? NOTE_ICON_MAP.info;
  return <Icon className={cn("h-4 w-4 shrink-0", NOTE_ICON_CLASS[key], className)} />;
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
        // 行无稳定 id,index 作 key(note 是只读展示列表)。
        // biome-ignore lint/suspicious/noArrayIndexKey: note rows are a static display list
        <RowLine key={i} row={row} formatNumber={formatNumber} />
      ))}
    </div>
  );
}

// 一个 Note:段首状态图标 + 标题(可 hideHeader 隐藏),下接 content。
export function NoteView({ note, formatNumber, hideHeader, className }: NoteViewProps) {
  const fmt = formatNumber ?? ((n: number) => String(n));
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {!hideHeader && (
        <div className="flex items-center gap-1.5">
          <NoteIconGlyph icon={note.icon} />
          <span className="text-base font-medium text-foreground">{note.title}</span>
        </div>
      )}
      <NoteContent content={note.content} formatNumber={fmt} />
    </div>
  );
}
