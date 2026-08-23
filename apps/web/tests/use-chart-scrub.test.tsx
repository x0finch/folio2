import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { useChartScrub } from "@/lib/hooks/use-chart-scrub";

// 划动读数(#470 片7):图表不再弹气泡,上方那个大数字被顶替成划到那一点的值 + 那一刻的时间。
// 这里测的是「划到哪 / 时间怎么写 / 松手回到什么状态」;手势与图表命中在 jsdom 里测不出来
// (没有布局、recharts 拿不到宽高),那部分靠浏览器与真机。

function wrap({ children }: { children: ReactNode }) {
  return (
    <IntlProvider locale="en" messages={{}} timeZone="UTC" now={new Date(0)}>
      {children}
    </IntlProvider>
  );
}

const AUG_12_1530_UTC = Date.UTC(2026, 7, 12, 15, 30);

describe("useChartScrub", () => {
  it("没在划 → 没有点、没有时间(调用方显示实时值)", () => {
    const { result } = renderHook(() => useChartScrub(), { wrapper: wrap });
    expect(result.current.point).toBeNull();
    expect(result.current.label).toBeNull();
  });

  it("划到某点 → 给出该点 + 月日时分", () => {
    const { result } = renderHook(() => useChartScrub(), { wrapper: wrap });
    act(() => {
      result.current.onActive({ t: AUG_12_1530_UTC, total: 1234 });
    });
    expect(result.current.point).toEqual({ t: AUG_12_1530_UTC, total: 1234 });
    // 只断言「日期与时分都在」,不钉具体标点 —— 那是 Intl 的排版,跟着 locale 走。
    expect(result.current.label).toContain("Aug");
    expect(result.current.label).toContain("12");
    expect(result.current.label).toMatch(/03:30|15:30/);
  });

  it("松手 / 移出 → 回到实时值那一态", () => {
    const { result } = renderHook(() => useChartScrub(), { wrapper: wrap });
    act(() => {
      result.current.onActive({ t: AUG_12_1530_UTC, total: 1234 });
    });
    act(() => {
      result.current.onActive(null);
    });
    expect(result.current.point).toBeNull();
    expect(result.current.label).toBeNull();
  });
});
