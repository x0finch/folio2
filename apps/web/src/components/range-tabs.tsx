import { Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useTranslations } from "use-intl";
import { type HistoryRange, rangeSince } from "@/lib/core/history-range";

export type { HistoryRange as Range } from "@/lib/core/history-range";
export { rangeSince };

const RANGES: HistoryRange[] = ["7d", "30d", "1y", "all"];

export function RangeTabs({
  value,
  onChange,
}: {
  value: HistoryRange;
  onChange: (r: HistoryRange) => void;
}) {
  const t = useTranslations("Overview");
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as HistoryRange)} variant="pill">
      <TabsList className="gap-0.5 bg-transparent p-0 leading-none">
        {RANGES.map((r) => (
          <TabsTrigger key={r} value={r} className="px-2 py-1 font-mono text-xs leading-none">
            {r === "all" ? t("rangeAll") : r.toUpperCase()}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
