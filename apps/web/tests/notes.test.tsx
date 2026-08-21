import type { Note } from "@folio/connectors-basic";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoteIndicator } from "@/components/notes/note-indicator";
import { NoteView } from "@/components/notes/note-view";

afterEach(cleanup);

// formatNumber 注入:打标记 <n>,断言数字值被格式化(而非裸 String)。
const formatNumber = (n: number) => `<${n}>`;

function renderNote(note: Note) {
  return render(<NoteView note={note} formatNumber={formatNumber} />);
}

describe("<NoteView>", () => {
  it("段首(icon + 标题)+ content 行列表渲染", () => {
    renderNote({
      title: "Locked",
      icon: "warning",
      content: [{ label: "BTC", value: 1, unit: "BTC" }],
    });
    expect(screen.getByText("Locked")).toBeTruthy();
    expect(screen.getByText("BTC")).toBeTruthy();
  });

  it("content string → 纯文本", () => {
    renderNote({ title: "Note", content: "Pending funds" });
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getByText("Pending funds")).toBeTruthy();
  });

  it("content NoteRow[] → 数字经 formatNumber + 单位", () => {
    renderNote({ title: "Locked", content: [{ label: "ETH", value: 2.5, unit: "ETH" }] });
    expect(screen.getByText("ETH")).toBeTruthy();
    // 数字值经注入 formatNumber(<2.5>)+ 单位符号。
    expect(screen.getByText("<2.5> ETH")).toBeTruthy();
  });

  it("字符串 value 原样呈现(不经 formatNumber)", () => {
    renderNote({ title: "Receive", content: [{ label: "Next #0", value: "bc1qexample" }] });
    expect(screen.getByText("bc1qexample")).toBeTruthy();
  });

  it("行有 href → 包外链(新标签 + noopener)", () => {
    const { container } = renderNote({
      title: "Distribution",
      content: [{ label: "addr", value: 1, unit: "BTC", href: "https://mempool.space/address/x" }],
    });
    const a = container.querySelector('a[href="https://mempool.space/address/x"]');
    expect(a).toBeTruthy();
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });

  it("hideHeader → 只渲染 content(段首 icon+标题不出现)", () => {
    render(
      <NoteView
        note={{ title: "Locked", icon: "warning", content: "held" }}
        formatNumber={formatNumber}
        hideHeader
      />,
    );
    expect(screen.queryByText("Locked")).toBeNull();
    expect(screen.getByText("held")).toBeTruthy();
  });

  it("未知 / 缺省 icon → 不崩(退化 info)", () => {
    expect(() => {
      renderNote({ title: "NoIcon", content: "text" });
      // @ts-expect-error 运行时兜底:未知 icon 名退化 info
      renderNote({ title: "Weird", icon: "nope", content: "text" });
    }).not.toThrow();
    expect(screen.getByText("NoIcon")).toBeTruthy();
    expect(screen.getByText("Weird")).toBeTruthy();
  });

  it("缺 formatNumber → 数字 String 化(安全退化)", () => {
    render(<NoteView note={{ title: "S", content: [{ label: "x", value: 7 }] }} />);
    expect(screen.getByText("7")).toBeTruthy();
  });
});

describe("<NoteIndicator>", () => {
  it("纯 icon 触发(aria-label=段标题)+ popover 内 NoteView 含标题", () => {
    render(
      <NoteIndicator
        note={{ title: "Frozen", icon: "warning", content: "0.5 ETH · 25%" }}
        formatNumber={formatNumber}
      />,
    );
    // 触发是纯 icon,无文字 → 用 aria-label 暴露段标题(无障碍)。
    expect(screen.getByLabelText("Frozen")).toBeTruthy();
    // popover 内容(NoteView 段首)含标题 + 内联文案(内容常驻 DOM,关闭时 inert)。
    expect(screen.getAllByText("Frozen").length).toBeGreaterThan(0);
    expect(screen.getByText("0.5 ETH · 25%")).toBeTruthy();
  });
});
