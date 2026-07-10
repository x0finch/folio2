import type { DetailBlock, DetailFormat } from "@folio/detail-block-basic";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BalanceDetail } from "../src/balance-detail";

afterEach(cleanup);

// 测试注入:translate 原样回 key(断言 key 出现),format 打上 [fmt] 前缀(断言 format 被传递)。
const translate = (key: string) => key;
const format = (value: number | string, fmt?: DetailFormat) => `${value}${fmt ? `[${fmt}]` : ""}`;

function renderBlocks(blocks: DetailBlock[]) {
  return render(<BalanceDetail blocks={blocks} translate={translate} format={format} />);
}

describe("<BalanceDetail>", () => {
  it("无块 → 渲染 null(现有行为不受影响)", () => {
    const { container } = render(
      <BalanceDetail blocks={[]} translate={translate} format={format} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("stat:渲染标签(i18n key)+ 按 format 格式化的值", () => {
    renderBlocks([{ type: "stat", label: "Overview.btcPending", value: 42, format: "sats" }]);
    expect(screen.getByText("Overview.btcPending")).toBeTruthy();
    expect(screen.getByText("42[sats]")).toBeTruthy();
  });

  it("keyValue:块标题 + 每项标签/值,数字项带 format、字符串项无", () => {
    renderBlocks([
      {
        type: "keyValue",
        label: "Cex.balances",
        items: [
          { label: "Cex.locked", value: 1.5, format: "usd" },
          { label: "Cex.note", value: "n/a" },
        ],
      },
    ]);
    expect(screen.getByText("Cex.balances")).toBeTruthy();
    expect(screen.getByText("1.5[usd]")).toBeTruthy();
    expect(screen.getByText("n/a")).toBeTruthy();
  });

  it("addressList:渲染地址(中缩)+ 复制按钮 + qr 二维码", () => {
    const address = "bc1qexampleaddress0000000000000000abcdef";
    const { container } = renderBlocks([
      { type: "addressList", label: "Overview.btcReceive", qr: true, items: [{ address }] },
    ]);
    // 复制按钮存在
    expect(screen.getByRole("button", { name: "Copy address" })).toBeTruthy();
    // 二维码(qrcode.react 渲染 svg)出现
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("addressList:复制按钮点击写剪贴板", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const address = "bc1qcopytarget0000000000000000000000abcdef";
    renderBlocks([{ type: "addressList", items: [{ address }] }]);
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith(address);
    vi.unstubAllGlobals();
  });

  it("未知块 type 被跳过、不崩;混入合法块仍渲染", () => {
    const blocks = [
      { type: "note", text: "future block" },
      { type: "stat", label: "keep.me", value: 7, format: "usd" },
    ] as unknown as DetailBlock[];
    expect(() => renderBlocks(blocks)).not.toThrow();
    expect(screen.getByText("keep.me")).toBeTruthy();
    expect(screen.queryByText("future block")).toBeNull();
  });

  it("全为未知块 → 渲染 null", () => {
    const blocks = [{ type: "table", rows: [] }] as unknown as DetailBlock[];
    const { container } = renderBlocks(blocks);
    expect(container.firstChild).toBeNull();
  });
});
