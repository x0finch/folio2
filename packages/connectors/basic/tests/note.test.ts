import { describe, expect, it } from "vitest";
import { Note, NoteRow } from "../src/note";

describe("Note 契约(note 重设计)", () => {
  it("note:content = 行列表(NoteRow[]),icon 5 值枚举可选", () => {
    const s = Note.parse({
      title: "Locked",
      icon: "warning",
      content: [{ label: "BTC", value: 0.5, unit: "BTC" }],
    });
    expect(s.title).toBe("Locked");
    expect(s.icon).toBe("warning");
    expect(Array.isArray(s.content)).toBe(true);
  });

  it("note:content = 纯文本段(string)", () => {
    const s = Note.parse({ title: "Note", content: "all funds available" });
    expect(s.content).toBe("all funds available");
  });

  it("icon 可省(缺省语义由渲染层退化 info)", () => {
    const s = Note.parse({ title: "T", content: "x" });
    expect(s.icon).toBeUndefined();
  });

  it("非法 icon 名 → parse 失败", () => {
    expect(Note.safeParse({ title: "T", icon: "nope", content: "x" }).success).toBe(false);
  });

  it("row:value 数字/文本裸联合,unit/href 可选", () => {
    const numeric = NoteRow.parse({ label: "amt", value: 1.25, unit: "ETH" });
    expect(numeric.value).toBe(1.25);
    const textual = NoteRow.parse({ label: "addr", value: "bc1q…", href: "https://x/y" });
    expect(textual.href).toBe("https://x/y");
    // value 可省(纯标签行)。
    expect(NoteRow.parse({ label: "only" }).value).toBeUndefined();
  });
});
