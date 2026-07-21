import { WheelPicker } from "@folio/ui";
import { useMemo } from "react";
import { useLocale } from "use-intl";

// manual 活动的发生日期选择器（grill Q7/Q8）：三滚轮 月/日/年 组合 beUI WheelPicker → occurredAt(ms)。
// 月名走当前 locale（Intl），日随月/年自动夹到有效上限，年窗 = 今年往前若干年。
// value/onChange 以本地零点 ms 表达（活动只关心到「天」）。

const YEAR_SPAN = 12; // 可选年份窗口：今年往前 YEAR_SPAN-1 年到今年

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function DateWheel({
  value,
  onChange,
  className,
}: {
  value: number;
  onChange: (ms: number) => void;
  className?: string;
}) {
  const locale = useLocale();
  const d = new Date(value);
  const year = d.getFullYear();
  const monthIndex = d.getMonth();
  const day = d.getDate();

  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);
  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => ({
        value: String(i),
        label: monthFmt.format(new Date(2000, i, 1)),
      })),
    [monthFmt],
  );

  const thisYear = new Date().getFullYear();
  const years = useMemo(
    () => Array.from({ length: YEAR_SPAN }, (_, i) => String(thisYear - (YEAR_SPAN - 1) + i)),
    [thisYear],
  );

  const dayCount = daysInMonth(year, monthIndex);
  const days = useMemo(() => Array.from({ length: dayCount }, (_, i) => String(i + 1)), [dayCount]);

  // 组合回 ms：换月/年后原日若越界（如 1/31 → 2 月）夹到该月末。
  const compose = (y: number, m: number, dd: number) => {
    const clampedDay = Math.min(dd, daysInMonth(y, m));
    onChange(new Date(y, m, clampedDay).getTime());
  };

  return (
    <div
      className={`flex items-stretch gap-1 rounded-2xl border border-border bg-background p-2 ${className ?? ""}`}
    >
      <WheelPicker
        options={months}
        value={String(monthIndex)}
        onValueChange={(v) => compose(year, Number(v), day)}
        className="flex-1 border-0 bg-transparent"
        sound
        aria-label="Month"
      />
      <WheelPicker
        options={days}
        value={String(day)}
        onValueChange={(v) => compose(year, monthIndex, Number(v))}
        className="w-14 border-0 bg-transparent"
        sound
        aria-label="Day"
      />
      <WheelPicker
        options={years}
        value={String(year)}
        onValueChange={(v) => compose(Number(v), monthIndex, day)}
        className="w-20 border-0 bg-transparent"
        sound
        aria-label="Year"
      />
    </div>
  );
}
