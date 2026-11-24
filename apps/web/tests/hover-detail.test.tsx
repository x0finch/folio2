import { act, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

//
vi.mock("motion/react", async (orig) => ({
  ...(await orig<object>()),
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { HoverDetail } = await import("@/components/hover-detail");

const PANEL = "detail-panel-content";

function mount(detail: ReactNode = <span>{PANEL}</span>) {
  const utils = render(
    <div data-testid="row">
      <HoverDetail detail={detail}>
        <span>trigger</span>
      </HoverDetail>
    </div>,
  );
  const trigger = () => utils.getByText("trigger").parentElement as HTMLElement;
  const panel = () =>
    [...document.body.querySelectorAll("div")].find((d) => d.style.position === "fixed") as
      | HTMLElement
      | undefined;
  return { ...utils, trigger, panel };
}

describe("HoverDetail", () => {
  it("no detail: renders only the trigger content, hover shows no overlay", () => {
    const { trigger, getByText, panel } = mount(null);
    fireEvent.mouseEnter(trigger());
    expect(getByText("trigger")).toBeTruthy();
    expect(panel()).toBeUndefined();
  });

  it("hover: detail mounts under body", () => {
    const { trigger, panel, getByTestId } = mount();
    expect(panel()).toBeUndefined();

    fireEvent.mouseEnter(trigger());

    const p = panel();
    expect(p?.textContent).toBe(PANEL);
    expect(getByTestId("row").contains(p as Node)).toBe(false);
  });

  it("leaving the trigger: collapses after a delay, not immediately", () => {
    vi.useFakeTimers();
    try {
      const { trigger, panel } = mount();
      fireEvent.mouseEnter(trigger());
      fireEvent.mouseLeave(trigger());
      expect(panel()).toBeDefined();
      act(() => vi.advanceTimersByTime(1000));
      expect(panel()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaving then re-entering the trigger: cancels the collapse", () => {
    vi.useFakeTimers();
    try {
      const { trigger, panel } = mount();
      fireEvent.mouseEnter(trigger());
      fireEvent.mouseLeave(trigger());
      fireEvent.mouseEnter(trigger());
      act(() => vi.advanceTimersByTime(1000));
      expect(panel()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moving from the trigger into the overlay: stays open", () => {
    vi.useFakeTimers();
    try {
      const { trigger, panel } = mount();
      fireEvent.mouseEnter(trigger());
      fireEvent.mouseLeave(trigger());
      fireEvent.mouseEnter(panel() as HTMLElement);
      act(() => vi.advanceTimersByTime(1000));
      expect(panel()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("click outside: collapses; click inside the overlay or on the trigger does not", () => {
    const { trigger, panel } = mount();
    fireEvent.mouseEnter(trigger());

    fireEvent.pointerDown(panel() as HTMLElement);
    expect(panel()).toBeDefined();
    fireEvent.pointerDown(trigger());
    expect(panel()).toBeDefined();

    fireEvent.pointerDown(document.body);
    expect(panel()).toBeUndefined();
  });
});
