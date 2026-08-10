import { cleanup, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { ValueDelta } from "../src/components/value-delta";
import { deltaTone, NO_VALUE } from "../src/lib/delta-display";

afterEach(cleanup);

// `delta` 是**三态**(ADR 0040),这组测试锁的就是这三态在界面上确实长得不一样:
//   · undefined —— 这个位置不该有增量(归档行)→ 整行省略
//   · null      —— 该有,但算不出 → `—`
//   · 0         —— 算出来确实没涨没跌 → `0`
// 改之前 null 和 0 都走「不渲染」,于是「不知道」和「没变」在界面上是同一个样子。

function renderDelta(props: Partial<React.ComponentProps<typeof ValueDelta>> = {}) {
  return render(
    <IntlProvider locale="en" messages={{}} timeZone="UTC" now={new Date(0)}>
      <ValueDelta value={1000} {...props} />
    </IntlProvider>,
  );
}

// 增量小字 = 市值那行之外的第二行。市值恒在,故取容器的第二个子元素。
function deltaLine(container: HTMLElement): HTMLElement | null {
  return (container.firstElementChild?.children[1] as HTMLElement | undefined) ?? null;
}

describe("<ValueDelta> 的三态", () => {
  it("undefined —— 整行省略(归档行:数字冻住,增量无从谈起)", () => {
    const { container } = renderDelta({ delta: undefined });
    expect(deltaLine(container)).toBeNull();
  });

  it("null —— 显示 `—`,不是留白", () => {
    const { container } = renderDelta({ delta: null });
    expect(deltaLine(container)?.textContent).toBe(NO_VALUE);
  });

  it("0 —— 显示金额 0,而不是被当成「没有」吞掉", () => {
    const { container } = renderDelta({ delta: 0 });
    const line = deltaLine(container);
    expect(line).not.toBeNull();
    expect(line?.textContent).not.toBe(NO_VALUE);
    // signedUsd 对 0 不带符号 —— 断言渲染出了一个 0 金额,而不是空。
    expect(line?.textContent).toMatch(/0/);
  });

  it("null 与 0 在界面上不是同一个东西", () => {
    const a = renderDelta({ delta: null });
    const b = renderDelta({ delta: 0 });
    expect(deltaLine(a.container)?.textContent).not.toBe(deltaLine(b.container)?.textContent);
  });
});

describe("<ValueDelta> 的方向与百分比", () => {
  it("正数带 + 与上涨色", () => {
    const { container } = renderDelta({ delta: 12.5 });
    const line = deltaLine(container);
    expect(line?.textContent).toContain("+");
    expect(line?.className).toContain("text-pos");
  });

  it("负数带真负号与下跌色", () => {
    const { container } = renderDelta({ delta: -12.5 });
    const line = deltaLine(container);
    expect(line?.textContent).toContain("−"); // U+2212,不是 ASCII 连字符
    expect(line?.className).toContain("text-neg");
  });

  it("pct 有则跟在金额后面,无则只显金额", () => {
    const withPct = renderDelta({ delta: 12.5, pct: 2.345 });
    expect(deltaLine(withPct.container)?.textContent).toContain("2.35%"); // toFixed(2)
    const without = renderDelta({ delta: 12.5 });
    expect(deltaLine(without.container)?.textContent).not.toContain("%");
  });

  it("市值为负(DeFi 净负债)仍走下跌色,与 delta 无关", () => {
    const { container } = renderDelta({ value: -500, delta: 1 });
    const valueLine = container.firstElementChild?.firstElementChild as HTMLElement;
    expect(valueLine.className).toContain("text-neg");
  });
});

describe("deltaTone", () => {
  it("算不出与没变都不带方向 —— 给 0 涂涨跌色是在暗示一个不存在的方向", () => {
    expect(deltaTone(null)).toBe(deltaTone(0));
    expect(deltaTone(0)).toContain("muted");
  });

  it("正负各自带色", () => {
    expect(deltaTone(1)).toContain("pos");
    expect(deltaTone(-1)).toContain("neg");
  });
});

describe("永续那条路不受波及", () => {
  // 永续单仓位行传的是 uPnL(number,恒有值),`ValueDelta` 只是形状共用 —— 三态改造不该动它。
  it("传入具体数值时渲染与方向不变", () => {
    const { container } = renderDelta({ delta: -42, pct: 1.5 });
    const line = deltaLine(container);
    expect(line?.className).toContain("text-neg");
    expect(line?.textContent).toContain("1.50%");
  });
});
