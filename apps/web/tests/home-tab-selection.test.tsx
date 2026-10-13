import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHomeTabSelection } from "@/routes/_authed/-home/tab/selection";
import { HomeViewStateProvider } from "@/routes/_authed/-home/view-state";

// 首页 tab 条的选中逻辑:切 tab、刚建的 pin 还没挂上时药丸不闪回 Tokens、pin 被删后回落默认 tab。

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
