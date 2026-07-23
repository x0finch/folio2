import { WheelPicker } from "@folio/ui";
import { useMemo } from "react";
import { useLocale } from "use-intl";

// manual 活动的发生时刻选择器:日期(年/月/日)与时间(时/分/秒)分开,由 `part` 决定渲染哪组滚轮 —— 两者独立打开、
// 不同时展开。组合 beUI WheelPicker → occurredAt(ms,到秒);只改 part 对应的字段,其余保持当前值。
// 年用完整年份(2026,滚轮更明确;摘要展示处裁到 2 位);月名走当前 locale(Intl);日随月/年夹到有效上限。
// 精确到秒:同一天多笔活动按真实先后排序、deriveAmount 折叠有序(不再靠「当天 0 点 + createdAt」凑)。

const YEAR_SPAN = 12; // 年份窗口:今年往前 YEAR_SPAN-1 年到今年

// 全程本地时区:manual 活动是用户输入的墙钟时间,按本地时区读写更符合直觉。摘要展示处也按本地格式化
// (绕开全站 UTC 的 useFormatter),两侧一致。
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}
const pad2 = (n: number) => String(n).padStart(2, "0");
const numOpts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ value: String(i), label: pad2(i) }));

export function DateTimeWheel({
  part,
  value,
  onChange,
  className,
}: {
  part: "date" | "time";
  value: number;
  onChange: (ms: number) => void;
  className?: string;
}) {
  const locale = useLocale();
  const d = new Date(value);
  const year = d.getFullYear();
  const monthIndex = d.getMonth();
  const day = d.getDate();
  const hour = d.getHours();
  const minute = d.getMinutes();
  const second = d.getSeconds();

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
  const hours = useMemo(() => numOpts(24), []);
  const minutes = useMemo(() => numOpts(60), []);
  const seconds = useMemo(() => numOpts(60), []);

  // 组合回 ms(本地):换月/年后原日越界(如 1/31 → 2 月)夹到该月末;毫秒清零(到秒)。
  const compose = (y: number, m: number, dd: number, hh: number, mi: number, ss: number) => {
    const clampedDay = Math.min(dd, daysInMonth(y, m));
    onChange(new Date(y, m, clampedDay, hh, mi, ss, 0).getTime());
  };

  const rowClass = `flex items-stretch gap-1 rounded-2xl border border-border bg-background p-2 ${className ?? ""}`;

  if (part === "date") {
    return (
      <div className={rowClass}>
        <WheelPicker
          options={months}
          value={String(monthIndex)}
          onValueChange={(v) => compose(year, Number(v), day, hour, minute, second)}
          className="flex-1 border-0 bg-transparent"
          sound
          aria-label="Month"
        />
        <WheelPicker
          options={days}
          value={String(day)}
          onValueChange={(v) => compose(year, monthIndex, Number(v), hour, minute, second)}
          className="w-14 border-0 bg-transparent"
          sound
          aria-label="Day"
        />
        <WheelPicker
          options={years}
          value={String(year)}
          onValueChange={(v) => compose(Number(v), monthIndex, day, hour, minute, second)}
          className="w-20 border-0 bg-transparent"
          sound
          aria-label="Year"
        />
      </div>
    );
  }

  return (
    <div className={rowClass}>
      <WheelPicker
        options={hours}
        value={String(hour)}
        onValueChange={(v) => compose(year, monthIndex, day, Number(v), minute, second)}
        className="flex-1 border-0 bg-transparent"
        sound
        aria-label="Hour"
      />
      <WheelPicker
        options={minutes}
        value={String(minute)}
        onValueChange={(v) => compose(year, monthIndex, day, hour, Number(v), second)}
        className="flex-1 border-0 bg-transparent"
        sound
        aria-label="Minute"
      />
      <WheelPicker
        options={seconds}
        value={String(second)}
        onValueChange={(v) => compose(year, monthIndex, day, hour, minute, Number(v))}
        className="flex-1 border-0 bg-transparent"
        sound
        aria-label="Second"
      />
    </div>
  );
}
