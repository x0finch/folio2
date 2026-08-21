import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SectionList } from "@/routes/_authed/-home/holdings/section-list";

// SectionList(ADR 0034):按小计倒序渲染各段 content;空段剔除;全空 → 不渲染。
// 首段(最大)省略 eyebrow 节头(UI 微调);后续段保留节头。
// content 传纯 div,免依赖 TokenHoldings 等重组件(那些的接线在 ④)。

describe("SectionList", () => {
  it("按小计倒序,首段无节头、后续段有,空段不出现", () => {
    const { container, queryByText } = render(
      <SectionList
        sections={[
          { key: "tokens", title: "Tokens", subtotal: 100, count: 2, content: <div>tok</div> },
          { key: "perps", title: "Perps", subtotal: 500, count: 1, content: <div>perp</div> },
          { key: "defi", title: "DeFi", subtotal: 0, count: 0, content: <div>defi</div> },
        ]}
      />,
    );
    const headers = [...container.querySelectorAll("span")]
      .map((el) => el.textContent)
      .filter((txt) => txt === "Tokens" || txt === "Perps" || txt === "DeFi");
    expect(headers).toEqual(["Tokens"]); // Perps 最大 → 首段省节头;Tokens 保留;DeFi(空)剔除
    expect(queryByText("defi")).toBeNull(); // 空段 content 不渲染
    expect(queryByText("perp")).not.toBeNull(); // 首段 content 仍渲染
    expect(queryByText("tok")).not.toBeNull();
  });

  it("全空 → 不渲染任何东西", () => {
    const { container } = render(
      <SectionList
        sections={[{ key: "tokens", title: "Tokens", subtotal: 0, count: 0, content: <div /> }]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
