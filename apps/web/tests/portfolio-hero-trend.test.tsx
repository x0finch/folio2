import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryPoint } from "@/lib/core/history";
import { messages } from "@/lib/i18n/messages";
import type { HoldingLike } from "@/routes/_authed/-home/hero/hero-stats";
import { PortfolioHero } from "@/routes/_authed/-home/hero/portfolio-hero";

afterEach(cleanup);

// 首页 hero 的趋势区**三态**(#444)。
//
// 为什么这条测试值得存在:这块地方原来只有两态,而那个 else 分支画的是 `DEMO_TREND` ——
// 24 个写死的数、一条平滑上扬的绿线。**它和真折线肉眼分不出来**(浏览器实测确认),于是
// 「有钱但只同步过一次」的账户会看到一条编出来的行情,而它头顶的 pill 完全可能写着 ▼ −1.55%。
// 同一屏自相矛盾。现在拆成三态,这组盯的就是别再退回去。
//
// **怎么分辨三态而不依赖 recharts 渲染**:jsdom 里容器尺寸是 0,ResponsiveContainer 量不到宽高
// 就不渲染子节点,所以断言 svg / gradient id 靠不住。改用两个 recharts 之外的标记:
//   · 右下角那个 `{spanDays}D` 跨度角标 —— 只有真有历史时才渲染
//   · 空态那句话
// 两个标记的组合把三态区分得干干净净,且不碰图库内部。
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

const holdings: readonly HoldingLike[] = [
  { token: { symbol: "BTC" }, totalValue: 100, gain24h: { amount: 1, pct: 1 } },
];

function renderHero(series: HistoryPoint[], totalUsd: number, held = holdings) {
  return render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
      <PortfolioHero series={series} totalUsd={totalUsd} gain24h={null} holdings={held} />
    </IntlProvider>,
  );
}

const emptyText = () => screen.queryByText(/once it's ready/i);
// 跨度角标:`11D` 这种。只在 hasHistory 且跨度 ≥ 1 天时出现。
const spanBadge = () => screen.queryByText(/^\d+D$/);

describe("hero 趋势区的三态", () => {
  it("① 有历史(≥2 点)→ 画真曲线,不出空态那句话", () => {
    renderHero(
      [
        { t: T0 - 3 * DAY, total: 100 },
        { t: T0, total: 110 },
      ],
      110,
    );

    expect(spanBadge()).toBeTruthy(); // 3D
    expect(emptyText()).toBeNull();
  });

  it("② 有钱但只有一个点 → 说明原因,**不画那条编出来的线**", () => {
    renderHero([{ t: T0, total: 110 }], 110);

    expect(emptyText()).toBeTruthy();
    expect(spanBadge()).toBeNull();
  });

  it("③ 什么都还没有(无持仓 + 总额 0)→ 保留装饰线,不说「数据不够」", () => {
    // 这时没有任何数字能被那条线矛盾,它只是个背景纹样;而正下方「还没有账户,去添加」
    // 已经说了该说的,再叠一句「数据不够」反而像报错。
    renderHero([], 0, []);

    expect(emptyText()).toBeNull();
    expect(spanBadge()).toBeNull();
  });

  it("一个点都没有但有持仓 → 仍然走说明,不走装饰", () => {
    // 归档/导入等路径可能给出空 series 而持仓非空。判据是「有没有东西」,不是「有没有点」。
    renderHero([], 110);

    expect(emptyText()).toBeTruthy();
  });

  it("**净值为负** → 走说明,绝不画那条上扬的装饰线", () => {
    // 这是判据从 `totalUsd > 0` 改成 `nothingYet` 的原因:perp 亏穿时净值为负,而按大于零判
    // 会掉进装饰线那支 —— 屏幕上是「净值 −$X」配一条平滑上扬的绿线,比总额 0 那种更糟。
    renderHero([{ t: T0, total: -500 }], -500);

    expect(emptyText()).toBeTruthy();
  });

  it("持有价值恰好 0 的灰尘仓位 → 走说明,不走装饰", () => {
    // 「有仓位」就不是「还什么都没有」,哪怕它现在一分不值。
    renderHero([], 0, [{ token: { symbol: "BTC" }, totalValue: 0, gain24h: null }]);

    expect(emptyText()).toBeTruthy();
  });

  it("走势还在取数 → 净值照常渲染,不闪空态那句话", () => {
    // #488 票 3:曲线是非挂起读取,没到不该拖住数字,也不该先闪一句「数据不够」。
    render(
      <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(T0)}>
        <PortfolioHero series={[]} totalUsd={110} gain24h={null} holdings={holdings} loading />
      </IntlProvider>,
    );

    expect(screen.getByText(/total net worth/i)).toBeTruthy();
    expect(emptyText()).toBeNull();
    expect(spanBadge()).toBeNull();
  });

  // (删)「24h 盈亏还在取 → 增量走骨架」:FOL-51 后盈亏随总览一起到,hero 没有独立的「盈亏还在取」
  // 态,`gainPending` 属性已删。这条用例连同那个属性一起退场。

  it("两个点但落在同一个钟点 → 被降采样并成一个,于是仍是空态", () => {
    // **这是个如实记录当前行为的用例,不是在为它背书**:降采样最细的桶是 1 小时、按绝对钟点切
    // (见 lib/history.ts),所以同一钟点内的两次同步只留最后一个点 → 画不出线。
    // 写侧按钟点折叠那条在 #461。这条测试的意义是:哪天那个行为变了,这里会红,提醒同步改文案 ——
    // 文案说的是「还需要更多数据」,而此刻数据其实是够的、只是被压掉了。
    const sameHour = new Date("2026-08-11T10:00:00Z").getTime();
    renderHero(
      [
        { t: sameHour + 5 * 60_000, total: 100 },
        { t: sameHour + 55 * 60_000, total: 110 },
      ],
      110,
    );

    expect(emptyText()).toBeTruthy();
  });
});
