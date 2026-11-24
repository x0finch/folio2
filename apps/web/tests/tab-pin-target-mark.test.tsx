import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PinTargetMark } from "@/routes/_authed/-home/tab/pin-target-mark";

describe("PinTargetMark: display marks of the three target kinds", () => {
  it("tag: #name", () => {
    const { container } = render(<PinTargetMark kind="tag" name="DeFi" />);
    expect(container.textContent).toBe("#DeFi");
  });

  it("account: @name", () => {
    const { container } = render(<PinTargetMark kind="account" name="Cold" />);
    expect(container.textContent).toBe("@Cold");
  });

  it("connector: type name, no #/@, image uses the resolved address", () => {
    const { container } = render(
      <PinTargetMark kind="connector" name="Binance" logo="/api/logo/platform/binance" />,
    );
    expect(container.textContent).toContain("Binance");
    expect(container.textContent).not.toMatch(/[#@]/);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/logo/platform/binance");
  });
});
