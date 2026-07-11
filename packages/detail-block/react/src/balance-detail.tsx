import type { DetailRow, DetailSection } from "@folio/connectors-basic";
import { BouncyAccordion, type BouncyAccordionItem } from "@folio/ui";
import { cn } from "@folio/ui/lib/utils";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Info,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";

// 账户级 detail 渲染器(DetailBlock 重设计):sections → beUI BouncyAccordion,每 section 一个 item。
// icon 名 → lucide 命名图标(缺省/未知 → info);content:string → 纯文本、DetailRow[] → 行列表;
// 行有 href 则整行包外链(新标签)。数字值经注入的 formatNumber(locale)格式化;label/title 英文字面。
// React list key(item + row)一律用 index(detail 是只读展示列表,不重排)。

// 5 个中性状态名 → lucide 命名图标。lucide 已把 AlertTriangle/AlertCircle 改名 TriangleAlert/CircleAlert。
const ICON_MAP: Record<string, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  help: CircleHelp,
};

export interface BalanceDetailProps {
  sections?: DetailSection[];
  // 数字值 locale 格式化(app 注入;通用包不依赖 use-intl / @folio/fx)。缺省 String 化,安全退化。
  formatNumber?: (n: number) => string;
  className?: string;
}

function RowLine({ row, formatNumber }: { row: DetailRow; formatNumber: (n: number) => string }) {
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

function SectionContent({
  content,
  formatNumber,
}: {
  content: DetailSection["content"];
  formatNumber: (n: number) => string;
}) {
  if (typeof content === "string") return <p>{content}</p>;
  return (
    <div className="flex flex-col gap-2">
      {content.map((row, i) => (
        // 行无稳定 id,index 作 key(detail 是只读展示列表)。
        // biome-ignore lint/suspicious/noArrayIndexKey: detail rows are a static display list
        <RowLine key={i} row={row} formatNumber={formatNumber} />
      ))}
    </div>
  );
}

// 账户级详情渲染:sections → BouncyAccordion items(id=index)。无 section → 渲染 null。
export function BalanceDetail({ sections, formatNumber, className }: BalanceDetailProps) {
  const list = sections ?? [];
  if (list.length === 0) return null;
  const fmt = formatNumber ?? ((n: number) => String(n));
  const items: BouncyAccordionItem[] = list.map((section, i) => {
    const Icon = ICON_MAP[section.icon ?? "info"] ?? ICON_MAP.info;
    return {
      // section 无稳定 id,index 作 id(→ 手风琴 React key);detail 只读展示列表,不重排。
      id: String(i),
      title: section.title,
      icon: <Icon className="h-4 w-4" />,
      description: <SectionContent content={section.content} formatNumber={fmt} />,
    };
  });
  return (
    <BouncyAccordion
      items={items}
      className={cn(className)}
      classNames={{ item: "border border-border", description: "text-foreground" }}
    />
  );
}
