import { WheelPicker } from "@folio/ui";
import { useMemo } from "react";
import { useLocale } from "use-intl";

// `part` picks the date or time wheels; only that part's fields change. Second precision keeps
// same-day activities in their real order.

const YEAR_SPAN = 12; // the current year and the YEAR_SPAN-1 years before it

// Local time throughout: manual activity times are wall-clock input.
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

  // Clamp the day when the month/year change makes it invalid (e.g. Jan 31 → Feb).
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
