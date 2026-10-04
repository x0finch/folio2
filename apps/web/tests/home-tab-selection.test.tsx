import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { revealTab, useHomeTabSelection } from "@/routes/_authed/-home/tab/selection";
import { HomeViewStateProvider } from "@/routes/_authed/-home/view-state";

// 首页 tab 条的选中逻辑:切 tab、刚建的 pin 还没挂上时药丸不闪回 Tokens、pin 被删后回落默认 tab;
// 以及选中的 tab 被滚进横向 tab 条的可视区(两侧留 16px 余量)。

type Api = ReturnType<typeof useHomeTabSelection>;

function mount(initialPins: { id: string }[]) {
  const api = { current: null as Api | null };
  function Probe({ pins }: { pins: { id: string }[] }) {
    api.current = useHomeTabSelection(pins);
    return null;
  }
  const ui = (pins: { id: string }[]) => (
    <HomeViewStateProvider>
      <Probe pins={pins} />
    </HomeViewStateProvider>
  );
  const view = render(ui(initialPins));
  return {
    api: api as { current: Api },
    setPins: (pins: { id: string }[]) => view.rerender(ui(pins)),
  };
}

describe("useHomeTabSelection", () => {
  it("默认是 Tokens", () => {
    const { api } = mount([]);
    expect(api.current.active).toBe("tokens");
    expect(api.current.shownActive).toBe("tokens");
  });

  it("切到视角 tab / 已有的 pin", () => {
    const { api } = mount([{ id: "pin-1" }]);
    act(() => api.current.selectTab("perps"));
    expect(api.current.shownActive).toBe("perps");
    act(() => api.current.selectTab("pin-1"));
    expect(api.current.active).toBe("pin-1");
    expect(api.current.shownActive).toBe("pin-1");
  });

  it("刚建的 pin 还没挂上:显示停在上一个有效 tab,挂上后自动切过去", () => {
    const { api, setPins } = mount([]);
    act(() => api.current.selectTab("defi"));
    act(() => api.current.selectTab("pin-new"));
    expect(api.current.active).toBe("pin-new");
    expect(api.current.shownActive).toBe("defi");
    setPins([{ id: "pin-new" }]);
    expect(api.current.shownActive).toBe("pin-new");
  });

  it("选中的 pin 被删了:回落默认 tab,不空白", () => {
    const { api, setPins } = mount([{ id: "pin-1" }]);
    act(() => api.current.selectTab("pin-1"));
    setPins([]);
    expect(api.current.active).toBe("pin-1");
    expect(api.current.shownActive).toBe("tokens");
  });
});

// 造一条横向滚动的 tab 条和其中一个 tab;jsdom 不做布局,位置由测试给定。
function stripWith(
  stripRect: { left: number; right: number },
  tabRect: { left: number; right: number },
) {
  const strip = document.createElement("div");
  strip.className = "flex overflow-x-auto";
  const tab = document.createElement("button");
  strip.appendChild(tab);
  let scroll = 100;
  Object.defineProperty(strip, "scrollLeft", {
    get: () => scroll,
    set: (v: number) => {
      scroll = v;
    },
  });
  strip.getBoundingClientRect = () => ({ ...stripRect }) as DOMRect;
  tab.getBoundingClientRect = () => ({ ...tabRect }) as DOMRect;
  return { strip, tab };
}

describe("revealTab", () => {
  it("tab 超出右边 → 向右滚到完全可见并留 16px", () => {
    const { strip, tab } = stripWith({ left: 0, right: 300 }, { left: 280, right: 340 });
    revealTab(tab);
    expect(strip.scrollLeft).toBe(100 + 340 + 16 - 300);
  });

  it("tab 超出左边 → 向左滚并留 16px", () => {
    const { strip, tab } = stripWith({ left: 0, right: 300 }, { left: -40, right: 20 });
    revealTab(tab);
    expect(strip.scrollLeft).toBe(100 - (0 - -40 + 16));
  });

  it("已完全可见(含余量)→ 不动", () => {
    const { strip, tab } = stripWith({ left: 0, right: 300 }, { left: 16, right: 284 });
    revealTab(tab);
    expect(strip.scrollLeft).toBe(100);
  });

  it("贴边但不够 16px 余量 → 也会滚", () => {
    const { strip, tab } = stripWith({ left: 0, right: 300 }, { left: 200, right: 290 });
    revealTab(tab);
    expect(strip.scrollLeft).toBe(106);
  });

  it("不在横向滚动条里 → 什么都不做,不抛", () => {
    const tab = document.createElement("button");
    document.createElement("div").appendChild(tab);
    expect(() => revealTab(tab)).not.toThrow();
  });
});
