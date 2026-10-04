import { act, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// 手记活动行的悬停 / 点按明细浮层(自搓,portal 到 body 逃出 SwipeableList 行的 overflow-hidden)。
// 钉住用户能感知的四件事:
// ① 没有明细内容 → 只渲染触发区,悬停什么都不出;
// ② 悬停 → 明细出现在 body 下(不在被裁剪的行容器里);
// ③ 离开触发区 → 稍等片刻收起,而在这段延迟里移进浮层则留住它(用户能把鼠标挪进去看);
// ④ 点外部 → 收起(触屏 tap 打开后唯一的收法);下方空间不够 → 上翻贴到触发区上方。
//
// AnimatePresence 换成直通:退场动画是 motion 的事,这里只关心「该不该在」—— 不然收起后节点还要
// 留一段退场时间,「立刻没了」与「延迟后没了」就分不出来。
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
  // 浮层 = body 下那个 position:fixed 的容器(不按内容找,好让「没有明细」那条也能断言它不存在)。
  const panel = () =>
    [...document.body.querySelectorAll("div")].find((d) => d.style.position === "fixed") as
      | HTMLElement
      | undefined;
  return { ...utils, trigger, panel };
}

function placeTrigger(el: HTMLElement, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ left: 40, right: 140, top, bottom, width: 100, height: bottom - top }) as DOMRect;
}

describe("HoverDetail", () => {
  it("没有明细 → 只渲染触发内容,悬停也不出浮层", () => {
    const { trigger, getByText, panel } = mount(null);
    fireEvent.mouseEnter(trigger());
    expect(getByText("trigger")).toBeTruthy();
    expect(panel()).toBeUndefined();
  });

  it("悬停 → 明细挂到 body 下、贴在触发区下方", () => {
    const { trigger, panel, getByTestId } = mount();
    placeTrigger(trigger(), 100, 120);
    expect(panel()).toBeUndefined();

    fireEvent.mouseEnter(trigger());

    const p = panel();
    expect(p?.textContent).toBe(PANEL);
    // 不在行容器里(那里 overflow-hidden 会把它裁掉)。
    expect(getByTestId("row").contains(p as Node)).toBe(false);
    expect(p?.style.top).toBe("128px"); // bottom + GAP
    expect(p?.style.bottom).toBe("");
  });

  it("触发区贴近视口底部 → 上翻到触发区上方", () => {
    const { trigger, panel } = mount();
    placeTrigger(trigger(), window.innerHeight - 50, window.innerHeight - 30);
    fireEvent.mouseEnter(trigger());
    expect(panel()?.style.bottom).toBe("58px"); // innerHeight - top + GAP
    expect(panel()?.style.top).toBe("");
  });

  it("离开触发区 → 延迟后收起(不是立刻没)", () => {
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

  it("离开后又回到触发区 → 取消收起", () => {
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

  it("离开触发区后移进浮层 → 留住,不收起", () => {
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

  it("点外部 → 收起;点浮层内部或触发区不收", () => {
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
