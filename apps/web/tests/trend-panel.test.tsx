import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryPoint } from "@/lib/core/history";
import { messages } from "@/lib/i18n/messages";
import { TrendPanel } from "@/routes/_authed/-home/hero/trend-panel";

afterEach(cleanup);

// 趋势区状态机(#444)。四种情况以前散在三个调用点各写一遍,门槛还得靠一条**源码扫描测试**
// 用正则盯「每处都写了 `>= 2 ?` 而不是 `&&`」—— 需要看源码来保证一致性,本身就说明该收成组件。
// 收进来之后这组直接测行为,那条扫描测试删掉了。
//
// **怎么在 jsdom 里分辨「画了图」**:容器尺寸是 0,ResponsiveContainer 量不到宽高就不渲染子节点,
// 所以断不到 svg / path。改断那层**裁溢出的包裹 div** —— 它是我们自己写的、必然渲染,而且只在
// 真画图那一支出现。装饰线那支没有这层包裹(它自带 pointer-events-none 的容器)。
const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

const two: HistoryPoint[] = [
  { t: T0 - DAY, total: 100 },
  { t: T0, total: 110 },
];

function renderPanel(props: Partial<Parameters<typeof TrendPanel>[0]> = {}) {
  const { container } = render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
      <TrendPanel series={[]} {...props} />
    </IntlProvider>,
  );
  return container;
}

const note = () => screen.queryByText(/once it's ready/i);
const chartWrapper = (c: HTMLElement) => c.querySelector(".absolute.inset-0.overflow-hidden");
const decoration = (c: HTMLElement) => c.querySelector("[class*='pointer-events-none']");

describe("四态", () => {
  it("够两个点 → 画图,不摆文案", () => {
    const c = renderPanel({ series: two });
    expect(chartWrapper(c)).toBeTruthy();
    expect(note()).toBeNull();
  });

  it("点不够 → 摆文案", () => {
    const c = renderPanel({ series: [{ t: T0, total: 110 }] });
    expect(note()).toBeTruthy();
    expect(chartWrapper(c)).toBeNull();
  });

  it("还在取数 → 什么都不渲染(否则闪一下文案再被图盖掉)", () => {
    const c = renderPanel({ loading: true });
    expect(note()).toBeNull();
    expect(c.firstChild).toBeNull();
  });

  it("还在取数时 decorate 也让位 —— 先别画装饰线", () => {
    const c = renderPanel({ loading: true, decorate: true });
    expect(note()).toBeNull();
    expect(decoration(c)).toBeNull();
    expect(c.firstChild).toBeNull();
  });

  it("decorate → 画装饰纹样,不摆文案", () => {
    const c = renderPanel({ decorate: true });
    expect(note()).toBeNull();
    expect(decoration(c)).toBeTruthy();
  });

  it("**有真数据时 decorate 让位**:两者都开,画的是真图", () => {
    // 这条守的是那个红线:装饰线与真折线肉眼分不出,一旦有真数据就绝不能让它顶上去。
    const c = renderPanel({ series: two, decorate: true });
    expect(chartWrapper(c)).toBeTruthy();
    expect(note()).toBeNull();
  });
});

describe("默认值按抽屉配好 —— 那两处调用只给原料", () => {
  it("不传 loading / decorate 时,点不够就是摆文案", () => {
    renderPanel({ series: [{ t: T0, total: 110 }] });
    expect(note()).toBeTruthy();
  });
});
