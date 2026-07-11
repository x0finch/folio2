import { describe, expect, expectTypeOf, it } from "vitest";
import { DetailIcon, DetailRow, DetailSection } from "../src/detail-block";

describe("DetailSection 契约(DetailBlock 重设计)", () => {
  it("section:content = 行列表(DetailRow[]),icon 5 值枚举可选", () => {
    const s = DetailSection.parse({
      title: "Locked",
      icon: "warning",
      content: [{ label: "BTC", value: 0.5, unit: "BTC" }],
    });
    expect(s.title).toBe("Locked");
    expect(s.icon).toBe("warning");
    expect(Array.isArray(s.content)).toBe(true);
  });

  it("section:content = 纯文本段(string)", () => {
    const s = DetailSection.parse({ title: "Note", content: "all funds available" });
    expect(s.content).toBe("all funds available");
  });

  it("icon 可省(缺省语义由渲染层退化 info)", () => {
    const s = DetailSection.parse({ title: "T", content: "x" });
    expect(s.icon).toBeUndefined();
  });

  it("非法 icon 名 → parse 失败", () => {
    expect(DetailSection.safeParse({ title: "T", icon: "nope", content: "x" }).success).toBe(false);
  });

  it("row:value 数字/文本裸联合,unit/href 可选", () => {
    const numeric = DetailRow.parse({ label: "amt", value: 1.25, unit: "ETH" });
    expect(numeric.value).toBe(1.25);
    const textual = DetailRow.parse({ label: "addr", value: "bc1q…", href: "https://x/y" });
    expect(textual.href).toBe("https://x/y");
    // value 可省(纯标签行)。
    expect(DetailRow.parse({ label: "only" }).value).toBeUndefined();
  });

  it("DetailIcon = 5 中性状态名", () => {
    expect(DetailIcon.options).toEqual(["info", "success", "warning", "error", "help"]);
    expectTypeOf<DetailIcon>().toEqualTypeOf<"info" | "success" | "warning" | "error" | "help">();
  });

  it("section 数组可整体 parse(账户级 detail 形状)", () => {
    const arr = DetailSection.array().parse([
      {
        title: "Unconfirmed",
        icon: "warning",
        content: [{ label: "Pending", value: 0.001, unit: "BTC" }],
      },
      {
        title: "Receive addresses",
        content: [{ label: "Next #0", value: "bc1q…", href: "https://mempool.space/address/bc1q" }],
      },
    ]);
    expect(arr).toHaveLength(2);
  });
});
