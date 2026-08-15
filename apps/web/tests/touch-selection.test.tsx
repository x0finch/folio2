import { cleanup, render } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it } from "vitest";
import { NoteView } from "../src/components/notes";
import { PageHeader } from "../src/components/page-header";
import { AccountName } from "../src/routes/_authed/-home/holdings/account-name";
import { ValueDelta } from "../src/routes/_authed/-home/holdings/value-delta";

afterEach(cleanup);

// 片3 的分界:**外壳不可选、内容可选**。
// base 层把 button/nav/header 整体设成 `user-select: none`(长按 Dock、tab、卡片不冒蓝色高亮),
// 而金额、账户名、备注正文长在那些按钮**里面** —— 全站目前没有任何复制按钮,长按复制是唯一途径,
// 所以这几处必须自己把选中放回来。
//
// 断言的是渲染结果上那个类:jsdom 没有 CSS,`user-select` 是否真生效在浏览器里量(见 PR 正文);
// 而「哪几块该带 select-text」是这一片的设计决定,值得钉住 —— 少了它不报错,只表现为
// 「某天长按复制不了了」。
function withIntl(node: React.ReactNode) {
  return render(
    <IntlProvider locale="en" messages={{}} timeZone="UTC" now={new Date(0)}>
      {node}
    </IntlProvider>,
  );
}

describe("长按:外壳不可选、内容可选", () => {
  it("金额块可选中", () => {
    const { container } = withIntl(<ValueDelta value={1234.5} delta={-12} pct={0.4} />);
    expect(container.querySelector(".select-text")).not.toBeNull();
  });

  it("账户名可选中", () => {
    const { container } = render(<AccountName name="ryan" />);
    expect(container.querySelector(".select-text")).not.toBeNull();
  });

  it("备注正文可选中", () => {
    const { container } = render(
      <NoteView note={{ icon: "info", title: "未确认", content: "3 笔待确认" }} />,
    );
    expect(container.querySelector(".select-text")).not.toBeNull();
  });

  it("页头标题是外壳 → 不可选", () => {
    const { container } = render(<PageHeader title="Overview" subtitle="4 个账户" />);
    expect(container.querySelector("h1")?.closest(".select-none")).not.toBeNull();
  });
});
