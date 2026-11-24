import { describe, expect, it } from "vitest";
import { Note, NoteRow } from "../src/note";

describe("Note contract", () => {
  it("content as a row list; icon is an optional 5-value enum", () => {
    const s = Note.parse({
      title: "Locked",
      icon: "warning",
      content: [{ label: "BTC", value: 0.5, unit: "BTC" }],
    });
    expect(s.title).toBe("Locked");
    expect(s.icon).toBe("warning");
    expect(Array.isArray(s.content)).toBe(true);
  });

  it("content as plain text", () => {
    const s = Note.parse({ title: "Note", content: "all funds available" });
    expect(s.content).toBe("all funds available");
  });

  it("icon is optional", () => {
    const s = Note.parse({ title: "T", content: "x" });
    expect(s.icon).toBeUndefined();
  });

  it("rejects an unknown icon name", () => {
    expect(Note.safeParse({ title: "T", icon: "nope", content: "x" }).success).toBe(false);
  });

  it("row value is number or text; unit/href optional", () => {
    const numeric = NoteRow.parse({ label: "amt", value: 1.25, unit: "ETH" });
    expect(numeric.value).toBe(1.25);
    const textual = NoteRow.parse({ label: "addr", value: "bc1q…", href: "https://x/y" });
    expect(textual.href).toBe("https://x/y");
    expect(NoteRow.parse({ label: "only" }).value).toBeUndefined();
  });
});
