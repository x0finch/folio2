import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";

// Occurred-at picker: date and time wheels each change only their own field, recombined in local time.
// Day clamps to month end on a month change (1/31 → Feb), and milliseconds are zeroed.
// With reduced motion the wheels render as clickable buttons; tests use that path (click = select).
vi.mock("motion/react", async (orig) => ({
  ...(await orig<object>()),
  useReducedMotion: () => true,
}));

const { DateTimeWheel } = await import("@/components/date-time-wheel");

// Last year: always within the year window; expectations use local Date too, so leap years don't matter.
const Y = new Date().getFullYear() - 1;
const BASE = new Date(Y, 0, 31, 10, 20, 30, 999).getTime(); // Jan 31 10:20:30.999

function mount(part: "date" | "time") {
  const onChange = vi.fn();
  const utils = render(
    <IntlProvider locale="en" timeZone="UTC">
      <DateTimeWheel part={part} value={BASE} onChange={onChange} />
    </IntlProvider>,
  );
  // The nth wheel (date: month/day/year; time: hour/minute/second).
  const wheel = (n: number) => utils.container.querySelectorAll("ul")[n] as HTMLElement;
  const cell = (n: number, label: string) =>
    [...wheel(n).querySelectorAll("button")].find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement;
  const picked = () => new Date(onChange.mock.calls.at(-1)?.[0] as number);
  return { ...utils, onChange, cell, picked };
}

describe("DateTimeWheel — date", () => {
  it("changing the day changes only the day; time kept, ms zeroed", () => {
    const { cell, onChange } = mount("date");
    fireEvent.click(cell(1, "15"));
    expect(onChange).toHaveBeenCalledWith(new Date(Y, 0, 15, 10, 20, 30, 0).getTime());
  });

  it("1/31 moved to February → day clamps to Feb's end, no overflow into March", () => {
    const { cell, picked } = mount("date");
    fireEvent.click(cell(0, "Feb"));
    const febEnd = new Date(Y, 2, 0).getDate(); // 28 or 29
    expect(picked().getTime()).toBe(new Date(Y, 1, febEnd, 10, 20, 30, 0).getTime());
  });

  it("changing the year changes only the year", () => {
    const { cell, onChange } = mount("date");
    fireEvent.click(cell(2, String(Y - 2)));
    expect(onChange).toHaveBeenCalledWith(new Date(Y - 2, 0, 31, 10, 20, 30, 0).getTime());
  });
});

describe("DateTimeWheel — time", () => {
  it("hour / minute / second each change their own field; date untouched", () => {
    const { cell, onChange } = mount("time");
    fireEvent.click(cell(0, "05"));
    expect(onChange).toHaveBeenLastCalledWith(new Date(Y, 0, 31, 5, 20, 30, 0).getTime());
    fireEvent.click(cell(1, "07"));
    expect(onChange).toHaveBeenLastCalledWith(new Date(Y, 0, 31, 10, 7, 30, 0).getTime());
    fireEvent.click(cell(2, "59"));
    expect(onChange).toHaveBeenLastCalledWith(new Date(Y, 0, 31, 10, 20, 59, 0).getTime());
  });
});
