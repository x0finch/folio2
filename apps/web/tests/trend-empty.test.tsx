import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { TrendEmpty } from "../src/components/trend-empty";
import { messages } from "../src/lib/i18n/messages";

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
    expect(screen.getByText(/one more sync/i)).toBeTruthy();
  });

  it("**还在取数时什么都不显示** —— 否则会闪一下这句话再被图盖掉", () => {
    const { container } = renderEmpty(true);
    expect(container.firstChild).toBeNull();
  });
});

describe("两个抽屉都接上了空态", () => {
  // 这两处的门槛(`>= 2`)本来各写各的,漏掉一处就是一半的抽屉仍然留白 —— 而那正是 #444 的形状。
  const COMPONENTS = join(import.meta.dirname, "../src/components");
  const files = ["asset-sheet.tsx", "account-detail-sheet.tsx"];

  it.each(files)("%s 在点不够时渲染 <TrendEmpty>", (file) => {
    const text = readFileSync(join(COMPONENTS, file), "utf8");
    expect(text, `${file} 没接空态`).toContain("<TrendEmpty");
    // 还得是**三元的否定分支**,不能是 `&&` —— `&&` 只会在够两点时渲染图,空的那一半仍然留白。
    expect(text).toMatch(/series\.length >= 2 \?/);
  });

  it("自测:`&&` 那种写法抓得到", () => {
    expect("{series.length >= 2 && (").not.toMatch(/series\.length >= 2 \?/);
  });
});
