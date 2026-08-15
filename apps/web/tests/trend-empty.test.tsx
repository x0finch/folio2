import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { messages } from "../src/lib/i18n/messages";
import { TrendEmpty } from "../src/routes/_authed/-home/hero/trend-empty";

afterEach(cleanup);

// 价值曲线画不出来时的空态(#444)。新建账户第一次同步后只有一张快照 → 一个点 → 连不成线,
// 而两个抽屉原来都是**什么都不渲染**,看起来像功能坏了。

function renderEmpty(loading: boolean) {
  return render(
    <IntlProvider locale="en" messages={messages.en} timeZone="UTC" now={new Date(0)}>
      <TrendEmpty loading={loading} />
    </IntlProvider>,
  );
}

describe("<TrendEmpty>", () => {
  it("点不够时说清楚,而不是留白", () => {
    renderEmpty(false);
    expect(screen.getByText(/once it's ready/i)).toBeTruthy();
  });

  it("**还在取数时什么都不显示** —— 否则会闪一下这句话再被图盖掉", () => {
    const { container } = renderEmpty(true);
    expect(container.firstChild).toBeNull();
  });
});

// 「每个调用点都接上了空态」那组源码扫描测试**删掉了**:门槛现在只在 TrendPanel 里写一次,
// 一处代码不需要拿正则去盯一致性。四态的行为测试见 trend-panel.test.tsx。
