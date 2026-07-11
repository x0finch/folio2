import type { DetailSection } from "@folio/connectors-basic";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BalanceDetail } from "../src/balance-detail";

afterEach(cleanup);

// formatNumber 注入:打标记 <n>,断言数字值被格式化(而非裸 String)。
const formatNumber = (n: number) => `<${n}>`;

function renderSections(sections: DetailSection[]) {
  return render(<BalanceDetail sections={sections} formatNumber={formatNumber} />);
}

describe("<BalanceDetail>", () => {
  it("无 section → 渲染 null", () => {
    const { container } = render(<BalanceDetail sections={[]} formatNumber={formatNumber} />);
    expect(container.firstChild).toBeNull();
  });

  it("每 section → 一个手风琴 item(title 作触发器)", () => {
    renderSections([
      { title: "Unconfirmed", icon: "warning", content: "Pending funds" },
      { title: "Locked", content: [{ label: "BTC", value: 1, unit: "BTC" }] },
    ]);
    expect(screen.getByRole("button", { name: /Unconfirmed/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Locked/ })).toBeTruthy();
  });

  it("content string → 纯文本;content DetailRow[] → 行列表,数字经 formatNumber + 单位", () => {
    renderSections([{ title: "Locked", content: [{ label: "ETH", value: 2.5, unit: "ETH" }] }]);
    expect(screen.getByText("ETH")).toBeTruthy();
    // 数字值经注入 formatNumber(<2.5>)+ 单位符号。
    expect(screen.getByText("<2.5> ETH")).toBeTruthy();
  });

  it("字符串 value 原样呈现(不经 formatNumber)", () => {
    renderSections([{ title: "Receive", content: [{ label: "Next #0", value: "bc1qexample" }] }]);
    expect(screen.getByText("bc1qexample")).toBeTruthy();
  });

  it("行有 href → 包外链(新标签 + noopener)", () => {
    const { container } = renderSections([
      {
        title: "Distribution",
        content: [
          { label: "addr", value: 1, unit: "BTC", href: "https://mempool.space/address/x" },
        ],
      },
    ]);
    const a = container.querySelector('a[href="https://mempool.space/address/x"]');
    expect(a).toBeTruthy();
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });

  it("未知 / 缺省 icon → 不崩(退化 info)", () => {
    expect(() =>
      renderSections([
        { title: "NoIcon", content: "text" },
        // @ts-expect-error 运行时兜底:未知 icon 名退化 info
        { title: "Weird", icon: "nope", content: "text" },
      ]),
    ).not.toThrow();
    expect(screen.getByRole("button", { name: /NoIcon/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Weird/ })).toBeTruthy();
  });

  it("缺 formatNumber → 数字 String 化(安全退化)", () => {
    render(<BalanceDetail sections={[{ title: "S", content: [{ label: "x", value: 7 }] }]} />);
    const region = screen.getByRole("region", { hidden: true });
    expect(within(region).getByText("7")).toBeTruthy();
  });
});
