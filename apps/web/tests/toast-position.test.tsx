import { Toaster, toast } from "@folio/ui";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

//
//

const STACK = 'ol[aria-live="polite"]';
const shown: string[] = [];

function showToast() {
  act(() => {
    shown.push(toast.message("同步完成"));
  });
}

afterEach(() => {
  act(() => {
    for (const id of shown.splice(0)) toast.dismiss(id);
  });
});

describe("<Toaster> positioning entry", () => {
  it("bottom-right by default (desktop)", () => {
    render(<Toaster />);
    showToast();
    const cls = document.querySelector(STACK)?.className ?? "";
    expect(cls).toContain("bottom-6");
    expect(cls).toContain("right-4");
    expect(cls).toContain("flex-col-reverse");
  });

  it("top-right: at the top, and the stacking direction flips (newest on top)", () => {
    render(<Toaster position="top-right" />);
    showToast();
    const cls = document.querySelector(STACK)?.className ?? "";
    expect(cls).toContain("top-4");
    expect(cls).not.toContain("bottom-6");
    expect(cls).toContain("flex-col");
    expect(cls).not.toContain("flex-col-reverse");
  });

  it("classNames.root can override its built-in top-4: on phones it must stack on the safe area, not cover the notch", () => {
    render(
      <Toaster
        position="top-right"
        classNames={{ root: "top-[calc(env(safe-area-inset-top)+0.75rem)]" }}
      />,
    );
    showToast();
    const cls = document.querySelector(STACK)?.className ?? "";
    expect(cls).toContain("top-[calc(env(safe-area-inset-top)+0.75rem)]");
    expect(cls).not.toMatch(/(^|\s)top-4(\s|$)/);
  });
});
