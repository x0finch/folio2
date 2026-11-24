import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHomeTabSelection } from "@/routes/_authed/-home/tab/selection";
import { HomeViewStateProvider } from "@/routes/_authed/-home/view-state";

// Home tab selection: a fresh pin not yet mounted doesn't flash the pill back to Tokens; a deleted pin falls back.

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
  it("defaults to Tokens", () => {
    const { api } = mount([]);
    expect(api.current.active).toBe("tokens");
    expect(api.current.shownActive).toBe("tokens");
  });

  it("switches to a view tab / an existing pin", () => {
    const { api } = mount([{ id: "pin-1" }]);
    act(() => api.current.selectTab("perps"));
    expect(api.current.shownActive).toBe("perps");
    act(() => api.current.selectTab("pin-1"));
    expect(api.current.active).toBe("pin-1");
    expect(api.current.shownActive).toBe("pin-1");
  });

  it("fresh pin not yet mounted: stays on the last valid tab, switches once it mounts", () => {
    const { api, setPins } = mount([]);
    act(() => api.current.selectTab("defi"));
    act(() => api.current.selectTab("pin-new"));
    expect(api.current.active).toBe("pin-new");
    expect(api.current.shownActive).toBe("defi");
    setPins([{ id: "pin-new" }]);
    expect(api.current.shownActive).toBe("pin-new");
  });

  it("selected pin deleted: falls back to the default tab, not blank", () => {
    const { api, setPins } = mount([{ id: "pin-1" }]);
    act(() => api.current.selectTab("pin-1"));
    setPins([]);
    expect(api.current.active).toBe("pin-1");
    expect(api.current.shownActive).toBe("tokens");
  });
});
