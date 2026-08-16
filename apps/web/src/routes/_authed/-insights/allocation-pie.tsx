import { Cell, Pie, PieChart } from "recharts";
import { useLocale, useTranslations } from "use-intl";
import { formatMoney } from "../../../lib/format-number";
import { usePreferCurrency } from "../../../lib/hooks/use-prefer-currency";
import { type AllocSlice, OTHERS_KEY } from "./allocation";

// 分配饼图 + 图例(Insights)。配色走 shadcn 图表 token(--chart-1..5,循环),不写死颜色。
const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function AllocationPie({ slices }: { slices: AllocSlice[] }) {
  const t = useTranslations("Insights");
  const { currency, rate } = usePreferCurrency();
  const locale = useLocale();
  const usd = (n: number) => formatMoney(n, { rate, locale, currency });

  if (slices.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("noData")}</p>;
  }

  const total = slices.reduce((s, x) => s + x.value, 0);
  const data = slices.map((s, i) => ({ ...s, color: COLORS[i % COLORS.length] }));
  const labelOf = (s: AllocSlice) => (s.key === OTHERS_KEY ? t("others") : s.label);

  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
      <div className="mx-auto shrink-0">
        <PieChart width={220} height={220}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            cx={110}
            cy={110}
            innerRadius={55}
            outerRadius={95}
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={d.color} stroke="var(--background)" strokeWidth={2} />
            ))}
          </Pie>
        </PieChart>
      </div>
      <ul className="flex flex-1 flex-col gap-1.5">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2 text-sm">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
            <span className="min-w-0 flex-1 truncate">{labelOf(d)}</span>
            <span className="text-muted-foreground text-xs">
              {total > 0 ? Math.round((d.value / total) * 100) : 0}%
            </span>
            <span className="w-24 text-right font-medium">{usd(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
