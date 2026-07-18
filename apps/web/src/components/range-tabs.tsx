import { Tabs, TabsList, TabsTrigger } from "@folio/ui";
import { useTranslations } from "use-intl";

// 价值历史的窗口切换(7D / 30D / 1Y / 全部)——资产抽屉与账户抽屉共用。
// beUI Tabs(透明底,pill 变体);无 TabsContent,value 驱动 chart 取数。
// TabsList 上 leading-none 关键:trigger 外层块 div 的行盒否则被继承的大 line-height 撑高
// (24px > 按钮 20px),使按钮(inline-flex)在其中偏移、绿 pill(= 外层 inset-0)比按钮高而文字
// 相对 pill 不居中;leading-none 让行盒由按钮决定 → pill=按钮 → 文字垂直居中。

export const DAY_MS = 86_400_000;
export type Range = "7d" | "30d" | "1y" | "all";
const RANGES: Range[] = ["7d", "30d", "1y", "all"];
export const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { "7d": 7, "30d": 30, "1y": 365 };

// range → since(epoch ms);"all" → undefined(不裁窗口)。nowMs 由调用方传入(可测/可控)。
export function rangeSince(range: Range, nowMs: number): number | undefined {
  return range === "all" ? undefined : nowMs - RANGE_DAYS[range] * DAY_MS;
}

export function RangeTabs({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const t = useTranslations("Overview");
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as Range)} variant="pill">
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
