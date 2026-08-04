import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SectionList } from "../src/components/section-list";

// SectionList(ADR 0034):按小计倒序渲染各段节头 + content;空段剔除;全空 → 不渲染。
// content 传纯 div,免依赖 TokenHoldings 等重组件(那些的接线在 ④)。

describe("SectionList", () => {
  it("按小计倒序渲染节头,空段不出现", () => {
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
    expect(headers).toEqual(["Perps", "Tokens"]); // 倒序,DeFi(空)剔除
    expect(queryByText("defi")).toBeNull(); // 空段 content 不渲染
    expect(queryByText("perp")).not.toBeNull();
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
