import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { Gain } from "../src/lib/gain-24h";
import { messages } from "../src/lib/i18n/messages";
import { GainExplainer } from "../src/routes/_authed/-home/hero/gain-explainer";

afterEach(cleanup);

// 24h 盈亏的解释弹层(#445)。它存在的理由是**一个看起来像 bug 的正确行为**:金额与百分比来自
// 两套计算,你动过仓的那天 `金额 ÷ 期初 ≠ 百分比`。这组测的就是那个解释确实摆出来了。
//
// beUI Popover 的面板内容常驻 DOM(关闭态靠动画/裁切藏起来,见 useHoverPopover 的 goo 垫底注释),
// 所以不必模拟 hover 就能断言内容 —— 也正因为如此,这里不去验「hover 才出现」那一层交互:
// 那是 beUI 自己的行为,仓库里 NoteIndicator / LiqRing 已经在用同一套。

const seg = (over: Partial<Gain["segments"][number]> = {}): Gain["segments"][number] => ({
  from: 1_700_000_000_000,
  to: 1_700_040_000_000,
  openValue: 100_000,
  gain: 5_000,
  pct: 5,
  openedByChange: false,
  ...over,
});

function renderExplainer(gain: Gain) {
  return render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
      <GainExplainer gain={gain}>
        <span>trigger</span>
      </GainExplainer>
    </IntlProvider>,
  );
}

describe("摊开计算过程", () => {
  it("一句话先说清口径 —— 买卖充提不算", () => {
    renderExplainer({ amount: 5_000, pct: 5, segments: [seg()] });
    expect(screen.getByText(/buys, sells and transfers don't count/i)).toBeTruthy();
  });

  it("每段一行,带这一段赚了多少", () => {
    renderExplainer({
      amount: 15_000,
      pct: 10,
      segments: [seg(), seg({ openValue: 210_000, gain: 10_000, pct: 4.76, openedByChange: true })],
    });
    expect(screen.getByText(/\+\$5,000/)).toBeTruthy();
    expect(screen.getByText(/\+\$10,000/)).toBeTruthy();
  });

  it("被你的动作切开的那一段要明说 —— 否则看不懂为什么在这儿断开", () => {
    renderExplainer({
      amount: 15_000,
      pct: 10,
      segments: [seg(), seg({ openedByChange: true })],
    });
    expect(screen.getByText(/you changed this position here/i)).toBeTruthy();
  });

  it("没动过手(只有一段)→ 不摆「为什么除不通」那句 —— 那时它本来就除得通", () => {
    renderExplainer({ amount: 5_000, pct: 5, segments: [seg()] });
    expect(screen.queryByText(/won't divide out/i)).toBeNull();
  });

  it("动过手(多段)→ 解释为什么金额 ÷ 期初 ≠ 百分比", () => {
    renderExplainer({
      amount: 15_000,
      pct: 10,
      segments: [seg(), seg({ openedByChange: true })],
    });
    expect(screen.getByText(/won't divide out/i)).toBeTruthy();
  });

  it("合计与收益率各一行", () => {
    renderExplainer({ amount: 15_000, pct: 10, segments: [seg()] });
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.getByText("Return")).toBeTruthy();
    expect(screen.getByText("+10.00%")).toBeTruthy();
  });

  it("百分比算不出(全是净负债段)→ 只摆金额,不硬造一个收益率", () => {
    renderExplainer({ amount: 1_000, pct: null, segments: [seg({ pct: null })] });
    expect(screen.getByText("Total")).toBeTruthy();
    expect(screen.queryByText("Return")).toBeNull();
  });
});
