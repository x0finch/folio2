import { render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { Stat } from "../src/components/stat";
import { ValueDelta } from "../src/components/value-delta";
import { NO_VALUE } from "../src/lib/delta-display";

// 「还在算」与「算不出」**必须长得不一样**(#488 的贯穿决定,口径见 lib/delta-display)。
//
// `—` 在全站是一句结论:问过了,答不上来。24h 盈亏另走一条读之后,它回来之前那些位置什么都
// 还没问完 —— 拿 `—` 顶着,就是先替服务端下一个结论,几百毫秒后再自己推翻。
//
// 这条测试钉的就是这件事,而它**值得钉**:两种状态在开发机上差几十毫秒,肉眼根本分不出谁是谁,
// 真正现形要到慢网上。code review 里已经抓到过一次漏网的(代币详情抽屉没拿到 pending,
// 于是行上画骨架、抽屉里画破折号,同一笔数两种说法)。
const wrap = (ui: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={{}}>
      {ui}
    </IntlProvider>,
  ).container;

describe("盈亏位的加载态", () => {
  it("ValueDelta:还在算 → 骨架,不是破折号", () => {
    const pending = wrap(<ValueDelta value={100} delta={null} pending />);
    expect(pending.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(pending.textContent).not.toContain(NO_VALUE);
  });

  it("ValueDelta:算不出 → 破折号,不是骨架", () => {
    const settled = wrap(<ValueDelta value={100} delta={null} />);
    expect(settled.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(settled.textContent).toContain(NO_VALUE);
  });

  it("Stat:两种状态同样分得开", () => {
    const pending = wrap(<Stat label="Best today" value={NO_VALUE} pending />);
    expect(pending.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(pending.textContent).not.toContain(NO_VALUE);

    const settled = wrap(<Stat label="Best today" value={NO_VALUE} />);
    expect(settled.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(settled.textContent).toContain(NO_VALUE);
  });

  it("两处用的是同一个骨架元件 —— 各写一份就会各自长歪", () => {
    const fromDelta = wrap(<ValueDelta value={1} delta={null} pending />).querySelector(
      '[data-slot="skeleton"]',
    );
    const fromStat = wrap(<Stat label="x" value="y" pending />).querySelector(
      '[data-slot="skeleton"]',
    );
    // 宽度按各自替换掉的真值定,其余(高度、圆角、动画)必须一致。
    expect(fromDelta?.className).toBe(fromStat?.className);
  });
});
