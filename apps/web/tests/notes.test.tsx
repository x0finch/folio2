import type { Note } from "@folio/connectors-basic";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoteIndicator } from "@/components/notes/note-indicator";
import { NoteView } from "@/components/notes/note-view";

afterEach(cleanup);

// Injected formatNumber tags values as <n> to prove numbers are formatted, not String()-ed.
const formatNumber = (n: number) => `<${n}>`;

function renderNote(note: Note) {
  return render(<NoteView note={note} formatNumber={formatNumber} />);
}

describe("<NoteView>", () => {
  it("renders header (icon + title) and the content row list", () => {
    renderNote({
      title: "Locked",
      icon: "warning",
      content: [{ label: "BTC", value: 1, unit: "BTC" }],
    });
    expect(screen.getByText("Locked")).toBeTruthy();
    expect(screen.getByText("BTC")).toBeTruthy();
  });

  it("content string -> plain text", () => {
    renderNote({ title: "Note", content: "Pending funds" });
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getByText("Pending funds")).toBeTruthy();
  });

  it("content NoteRow[] -> numbers via formatNumber + unit", () => {
    renderNote({ title: "Locked", content: [{ label: "ETH", value: 2.5, unit: "ETH" }] });
    expect(screen.getByText("ETH")).toBeTruthy();
    expect(screen.getByText("<2.5> ETH")).toBeTruthy();
  });

  it("string values render as-is (no formatNumber)", () => {
    renderNote({ title: "Receive", content: [{ label: "Next #0", value: "bc1qexample" }] });
    expect(screen.getByText("bc1qexample")).toBeTruthy();
  });

  it("row with href -> external link (new tab + noopener)", () => {
    const { container } = renderNote({
      title: "Distribution",
      content: [{ label: "addr", value: 1, unit: "BTC", href: "https://mempool.space/address/x" }],
    });
    const a = container.querySelector('a[href="https://mempool.space/address/x"]');
    expect(a).toBeTruthy();
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });

  it("hideHeader -> renders only content (no header icon/title)", () => {
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

  it("unknown / missing icon -> no crash (falls back to info)", () => {
    expect(() => {
      renderNote({ title: "NoIcon", content: "text" });
      // @ts-expect-error runtime fallback: unknown icon name degrades to info
      renderNote({ title: "Weird", icon: "nope", content: "text" });
    }).not.toThrow();
    expect(screen.getByText("NoIcon")).toBeTruthy();
    expect(screen.getByText("Weird")).toBeTruthy();
  });

  it("missing formatNumber -> numbers String()-ed (safe fallback)", () => {
    render(<NoteView note={{ title: "S", content: [{ label: "x", value: 7 }] }} />);
    expect(screen.getByText("7")).toBeTruthy();
  });
});

describe("<NoteIndicator>", () => {
  it("icon-only trigger (aria-label = section title) + popover NoteView includes the title", () => {
    render(
      <NoteIndicator
        note={{ title: "Frozen", icon: "warning", content: "0.5 ETH · 25%" }}
        formatNumber={formatNumber}
      />,
    );
    // Icon-only trigger exposes the section title via aria-label.
    expect(screen.getByLabelText("Frozen")).toBeTruthy();
    // Popover content stays in the DOM (inert when closed).
    expect(screen.getAllByText("Frozen").length).toBeGreaterThan(0);
    expect(screen.getByText("0.5 ETH · 25%")).toBeTruthy();
  });
});
