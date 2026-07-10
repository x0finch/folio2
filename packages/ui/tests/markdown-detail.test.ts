import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownDetail } from "../src/components/markdown-detail";

// 轻量 smoke:MarkdownDetail 渲染 provider 拼的 markdown。静态渲染(react-dom/server,无需 jsdom)。
// 覆盖:markdown → HTML(bold/list/link);a 通用覆盖带 target=_blank + rel=noopener(全局行为)。
const render = (md: string) => renderToStaticMarkup(createElement(MarkdownDetail, { md }));

describe("MarkdownDetail", () => {
  it("renders bold + list markdown to HTML", () => {
    const html = render("**Unconfirmed:** +0.005 BTC\n\n- Available: 2 ETH\n- Locked: 1 ETH");
    expect(html).toContain("<strong>Unconfirmed:</strong>");
    expect(html).toContain("<li>Available: 2 ETH</li>");
    expect(html).toContain("prose"); // typography 容器
  });

  it("renders links with target=_blank + rel=noopener (global a override)", () => {
    const html = render(
      "[bc1qcr8te4…306fyu](https://mempool.space/address/bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu)",
    );
    expect(html).toContain(
      'href="https://mempool.space/address/bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain(" node="); // react-markdown 的 node prop 已剥离
  });
});
