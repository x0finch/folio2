import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PinTargetMark } from "../src/components/pin-target-mark";

// #488 票 4:tab 条上的自定义 Tab 标签与今天完全一致 —— 三种目标类型都验过。
// `#` / `@` 是纯展示前缀;连接器走 logo + 类型名,没有 #/@。

describe("PinTargetMark —— 三种目标的展示标记", () => {
  it("标签 → #名", () => {
    const { container } = render(<PinTargetMark kind="tag" name="DeFi" />);
    expect(container.textContent).toBe("#DeFi");
  });

  it("账户 → @名", () => {
    const { container } = render(<PinTargetMark kind="account" name="Cold" />);
    expect(container.textContent).toBe("@Cold");
  });

  it("连接器 → 类型名,没有 #/@,图走已解析的地址", () => {
    const { container } = render(
      <PinTargetMark kind="connector" name="Binance" logo="/api/logo/platform/binance" />,
    );
    expect(container.textContent).toContain("Binance");
    expect(container.textContent).not.toMatch(/[#@]/);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/logo/platform/binance");
  });
});
