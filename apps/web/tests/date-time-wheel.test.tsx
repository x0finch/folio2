import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";

// 手记活动「发生时刻」选择器:日期 / 时间两组滚轮各改各的字段,组合回本地时区的毫秒。
// 钉住的是**组合规则**,不是滚轮本身:
// ① 只改被拨动的那一格,其余(年月日时分秒)原样保留;
// ② 换月后原日越界(1/31 → 2 月)夹到该月末,而不是让 Date 溢出成 3 月初;
// ③ 毫秒清零(精确到秒,同一天多笔按真实先后排);
// ④ 月名跟随界面语言。
//
// 滚轮在「减少动效」模式下渲染成一列可点的按钮(无拖拽物理)—— 测试走这条,点一下 = 拨到那一格。
vi.mock("motion/react", async (orig) => ({
  ...(await orig<object>()),
  useReducedMotion: () => true,
}));

const { DateTimeWheel } = await import("@/components/date-time-wheel");

// 去年(总在年份窗口里,且不是闰年也无所谓 —— 期望值同样按本地 Date 算)。
const Y = new Date().getFullYear() - 1;
const BASE = new Date(Y, 0, 31, 10, 20, 30, 999).getTime(); // 1 月 31 日 10:20:30.999

function mount(part: "date" | "time", locale = "en") {
  const onChange = vi.fn();
  const utils = render(
    <IntlProvider locale={locale} timeZone="UTC">
      <DateTimeWheel part={part} value={BASE} onChange={onChange} />
    </IntlProvider>,
  );
  // 第 n 个滚轮(date: 月/日/年;time: 时/分/秒)里文字为 label 的那一格。
  const wheel = (n: number) => utils.container.querySelectorAll("ul")[n] as HTMLElement;
  const cell = (n: number, label: string) =>
    [...wheel(n).querySelectorAll("button")].find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement;
  const labels = (n: number) => [...wheel(n).querySelectorAll("button")].map((b) => b.textContent);
  const picked = () => new Date(onChange.mock.calls.at(-1)?.[0] as number);
  return { ...utils, onChange, cell, labels, picked };
}

describe("DateTimeWheel — 日期", () => {
  it("三个滚轮:月(本地化短名)/ 日(随月份天数)/ 年(含今年)", () => {
    const { labels } = mount("date");
    expect(labels(0)).toHaveLength(12);
    expect(labels(0)[0]).toBe("Jan");
    expect(labels(1)).toHaveLength(31); // 1 月
    expect(labels(2)).toContain(String(Y + 1));
  });

  it("月名跟随界面语言", () => {
    const { labels } = mount("date", "fr");
    expect(labels(0)[0]).toBe(
      new Intl.DateTimeFormat("fr", { month: "short" }).format(new Date(2000, 0, 1)),
    );
    expect(labels(0)[0]).not.toBe("Jan");
  });

  it("拨日 → 只改日,时分秒保留、毫秒清零", () => {
    const { cell, onChange } = mount("date");
    fireEvent.click(cell(1, "15"));
    expect(onChange).toHaveBeenCalledWith(new Date(Y, 0, 15, 10, 20, 30, 0).getTime());
  });

  it("1/31 拨到 2 月 → 日夹到 2 月末,不溢出到 3 月", () => {
    const { cell, picked } = mount("date");
    fireEvent.click(cell(0, "Feb"));
    const febEnd = new Date(Y, 2, 0).getDate(); // 28 或 29
    expect(picked().getTime()).toBe(new Date(Y, 1, febEnd, 10, 20, 30, 0).getTime());
  });

  it("拨年 → 只改年", () => {
    const { cell, onChange } = mount("date");
    fireEvent.click(cell(2, String(Y - 2)));
    expect(onChange).toHaveBeenCalledWith(new Date(Y - 2, 0, 31, 10, 20, 30, 0).getTime());
  });
});

describe("DateTimeWheel — 时间", () => {
  it("时 / 分 / 秒 三个两位数滚轮", () => {
    const { labels } = mount("time");
    expect(labels(0)).toHaveLength(24);
    expect(labels(0)[0]).toBe("00");
    expect(labels(1)).toHaveLength(60);
    expect(labels(2)).toHaveLength(60);
  });

  it("拨时 / 分 / 秒 → 各改各的,日期不动", () => {
    const { cell, onChange } = mount("time");
    fireEvent.click(cell(0, "05"));
    expect(onChange).toHaveBeenLastCalledWith(new Date(Y, 0, 31, 5, 20, 30, 0).getTime());
    fireEvent.click(cell(1, "07"));
    expect(onChange).toHaveBeenLastCalledWith(new Date(Y, 0, 31, 10, 7, 30, 0).getTime());
    fireEvent.click(cell(2, "59"));
    expect(onChange).toHaveBeenLastCalledWith(new Date(Y, 0, 31, 10, 20, 59, 0).getTime());
  });
});
