import type { Currency } from "@folio/oracle-basic";
import { SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryPoint } from "@/lib/core/history";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { CurrencyProvider } from "@/lib/hooks/use-prefer-currency";
import { messages } from "@/lib/i18n/messages";
import { OTHERS_KEY } from "@/routes/_authed/-insights/allocation";
import { AllocationPie } from "@/routes/_authed/-insights/allocation-pie";
import { PortfolioChart } from "@/routes/_authed/-insights/portfolio-chart";

// Insights 页两张图里**我们自己写的那部分**:
//   · 净值走势(PortfolioChart):X 轴按整段跨度换刻度(< 2 天 →「时:分」,否则「月 日」)、Y 轴用紧凑
//     金额、tooltip 用完整金额 + 日期时间;金额都按偏好币种换算;开了隐私时 tooltip 里的净值被遮。
//   · 分布饼图(AllocationPie):图例的名字 / 占比 / 金额、尾部「其他」的翻译、空数据的提示;开隐私时
//     只遮金额、留占比。
// 不断言 recharts 的几何。图例是我们自己的 <ul>;坐标轴与 tooltip 的文字是我们的 formatter 产出的。
//
// **怎么让 ResponsiveContainer 在 jsdom 里画出来**:它靠 ResizeObserver 回报尺寸,setup 里那个 stub
// 永不回报 → 0×0 → 什么都不画。这里换一个 observe 时立刻回报 600×220 的,画完还原。
// tooltip 用键盘打开(聚焦图面 + →),不靠鼠标坐标 —— jsdom 里元素没有几何,鼠标那条路摸不到点。

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10);

class SizedResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 600, height: 220 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

const originalRO = globalThis.ResizeObserver;
beforeEach(() => {
  globalThis.ResizeObserver = SizedResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = originalRO;
  cleanup();
});

const EUR = SUPPORTED_CURRENCIES.find((c) => c.code === "EUR") as Currency;

function wrap(
  ui: ReactNode,
  opts: { currency?: { currency: Currency; rate: number }; hide?: boolean } = {},
) {
  let tree = (
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
      {ui}
    </IntlProvider>
  );
  if (opts.currency) tree = <CurrencyProvider value={opts.currency}>{tree}</CurrencyProvider>;
  // 不传 hide → 不挂 Provider = 隐私关(缺省)。
  if (opts.hide != null)
    tree = <BalancePrivacyProvider hideBalances={opts.hide}>{tree}</BalancePrivacyProvider>;
  return render(tree);
}

function openTooltip(container: HTMLElement) {
  const surface = container.querySelector(".recharts-surface") as SVGElement;
  act(() => {
    surface.focus();
  });
  fireEvent.keyDown(surface, { key: "ArrowRight" });
}

const series = (points: [number, number][]): HistoryPoint[] =>
  points.map(([t, total]) => ({ t, total }));

describe("PortfolioChart —— 坐标轴与 tooltip 的文字", () => {
  it("跨度 ≥ 2 天 → X 轴是「月 日」,Y 轴是紧凑金额", () => {
    const { container } = wrap(
      <PortfolioChart
        series={series([
          [T0 - 5 * DAY, 1_000],
          [T0, 13_100],
        ])}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Jan 5");
    expect(text).toContain("Jan 10");
    expect(text).toContain("$14.00K"); // 紧凑:不是 $14,000.00
    expect(text).not.toContain("$14,000.00");
  });

  it("跨度 < 2 天 → X 轴换成「时:分」(同一天多次同步才分得开)", () => {
    const { container } = wrap(
      <PortfolioChart
        series={series([
          [T0, 100],
          [T0 + 6 * 3_600_000, 110],
        ])}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/12:00\s?AM/);
    expect(text).not.toContain("Jan 10");
  });

  it("tooltip 用完整金额 + 日期时间", () => {
    const { container } = wrap(
      <PortfolioChart
        series={series([
          [T0 - 5 * DAY, 1_000],
          [T0, 13_100],
        ])}
      />,
    );
    openTooltip(container);
    const text = container.textContent ?? "";
    expect(text).toContain("$13,100.00");
    expect(text).toMatch(/Jan 10, 12:00\s?AM/);
  });

  it("金额按偏好币种换算(轴与 tooltip 都是)", () => {
    // rate = 1 欧元的美元价;0.5 → 展示值翻倍。
    const { container } = wrap(
      <PortfolioChart
        series={series([
          [T0 - 5 * DAY, 1_000],
          [T0, 13_100],
        ])}
      />,
      { currency: { currency: EUR, rate: 0.5 } },
    );
    openTooltip(container);
    const text = container.textContent ?? "";
    expect(text).toContain("€26,200.00");
    expect(text).not.toContain("$");
  });

  it("开隐私 → tooltip 里的净值被遮,轴刻度照常(那是图的尺度)", () => {
    const { container } = wrap(
      <PortfolioChart
        series={series([
          [T0 - 5 * DAY, 1_000],
          [T0, 13_100],
        ])}
      />,
      { hide: true },
    );
    openTooltip(container);
    const masked = screen.getByRole("button", { name: /balance hidden/i });
    expect(masked.textContent).toContain("$13,100.00");
    expect(container.textContent).toContain("$14.00K");
    expect(screen.getAllByRole("button", { name: /balance hidden/i })).toHaveLength(1);
  });
});

const legendRows = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((li) => li.textContent ?? "");

describe("AllocationPie —— 图例", () => {
  it("没有切片 → 提示没数据,不画饼", () => {
    const { container } = wrap(<AllocationPie slices={[]} />);
    expect(screen.getByText("No data yet.")).toBeTruthy();
    expect(container.querySelector("li")).toBeNull();
  });

  it("每格一行:名字 · 四舍五入的占比 · 金额;尾部合并项显示「Others」", () => {
    const { container } = wrap(
      <AllocationPie
        slices={[
          { key: "btc", label: "BTC", value: 666 },
          { key: "eth", label: "ETH", value: 234 },
          { key: OTHERS_KEY, label: OTHERS_KEY, value: 100 },
        ]}
      />,
    );
    expect(legendRows(container)).toEqual(["BTC67%$666.00", "ETH23%$234.00", "Others10%$100.00"]);
  });

  it("总额为 0 → 占比写 0%,不出 NaN", () => {
    const { container } = wrap(<AllocationPie slices={[{ key: "x", label: "X", value: 0 }]} />);
    expect(legendRows(container)).toEqual(["X0%$0.00"]);
  });

  it("金额按偏好币种换算", () => {
    const { container } = wrap(
      <AllocationPie slices={[{ key: "btc", label: "BTC", value: 50 }]} />,
      {
        currency: { currency: EUR, rate: 0.5 },
      },
    );
    expect(legendRows(container)).toEqual(["BTC100%€100.00"]);
  });

  it("开隐私 → 每格金额被遮,占比留着", () => {
    wrap(
      <AllocationPie
        slices={[
          { key: "btc", label: "BTC", value: 75 },
          { key: "eth", label: "ETH", value: 25 },
        ]}
      />,
      { hide: true },
    );
    const masked = screen.getAllByRole("button", { name: /balance hidden/i });
    expect(masked.map((m) => m.textContent)).toEqual(["$75.00", "$25.00"]);
    expect(screen.getByText("75%")).toBeTruthy();
  });
});
