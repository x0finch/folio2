import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDE_BALANCES_CACHE_KEY, REVEAL_IDLE_MS } from "@/lib/hooks/balance-privacy";
import { BalancePrivacyProvider, useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe() {
  const { hidden, reveal } = useBalancePrivacy();
  return (
    <button type="button" onClick={reveal}>
      {hidden ? "hidden" : "shown"}
    </button>
  );
}

function mount(hideBalances: boolean | undefined) {
  const r = render(
    <BalancePrivacyProvider hideBalances={hideBalances}>
      <Probe />
    </BalancePrivacyProvider>,
  );
  return {
    ...r,
    rerenderWith: (next: boolean | undefined) =>
      r.rerender(
        <BalancePrivacyProvider hideBalances={next}>
          <Probe />
        </BalancePrivacyProvider>,
      ),
  };
}

const state = () => screen.getByRole("button").textContent;

describe("cold start: the cache decides the initial value", () => {
  it("no Provider: not masked (an isolated component should not be blurred, nor throw)", () => {
    render(<Probe />);
    expect(state()).toBe("shown");
  });

  it("no cache, server value not yet arrived: masked first (fail-closed)", () => {
    mount(undefined);
    expect(state()).toBe("hidden");
  });

  it("cache is OFF, server value not yet arrived: not masked right away, no flash", () => {
    localStorage.setItem(HIDE_BALANCES_CACHE_KEY, "0");
    mount(undefined);
    expect(state()).toBe("shown");
  });

  it("cache read throws (private window): treated as no cache, fail-closed, no crash", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount(undefined);
    expect(state()).toBe("hidden");
  });
});

describe("authoritative server value: calibrates + writes back to the cache", () => {
  it("server says off: not masked, and OFF is written back to the cache (no flash on next cold start)", () => {
    mount(false);
    expect(state()).toBe("shown");
    expect(localStorage.getItem(HIDE_BALANCES_CACHE_KEY)).toBe("0");
  });

  it("cache says off, server says on: server wins, becomes masked, cache synced to ON", () => {
    localStorage.setItem(HIDE_BALANCES_CACHE_KEY, "0");
    mount(true);
    expect(state()).toBe("hidden");
    expect(localStorage.getItem(HIDE_BALANCES_CACHE_KEY)).toBe("1");
  });

  it("authoritative value goes from on to off: unmasked immediately", () => {
    const m = mount(true);
    expect(state()).toBe("hidden");
    m.rerenderWith(false);
    expect(state()).toBe("shown");
    expect(localStorage.getItem(HIDE_BALANCES_CACHE_KEY)).toBe("0");
  });

  it("cache write throws: swallowed, page carries on", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    mount(true);
    expect(state()).toBe("hidden");
  });
});

describe("temporary reveal and re-hide", () => {
  it("one click: temporarily revealed", () => {
    mount(true);
    fireEvent.click(screen.getByRole("button"));
    expect(state()).toBe("shown");
  });

  it("window loses focus: hides again", () => {
    mount(true);
    fireEvent.click(screen.getByRole("button"));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(state()).toBe("hidden");
  });

  it("goes to background (visibilitychange hidden): hides again; the return to foreground does not count", () => {
    mount(true);
    fireEvent.click(screen.getByRole("button"));
    const vis = vi.spyOn(document, "visibilityState", "get");

    vis.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(state()).toBe("shown");

    vis.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(state()).toBe("hidden");
  });

  it("idle timeout: hides automatically", () => {
    vi.useFakeTimers();
    mount(true);
    fireEvent.click(screen.getByRole("button"));
    act(() => {
      vi.advanceTimersByTime(REVEAL_IDLE_MS - 1);
    });
    expect(state()).toBe("shown");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(state()).toBe("hidden");
  });

  it("activity midway: idle timer restarts (only real idleness re-hides)", () => {
    vi.useFakeTimers();
    mount(true);
    fireEvent.click(screen.getByRole("button"));
    act(() => {
      vi.advanceTimersByTime(REVEAL_IDLE_MS - 1_000);
    });
    act(() => {
      window.dispatchEvent(new Event("mousemove"));
    });
    act(() => {
      vi.advanceTimersByTime(REVEAL_IDLE_MS - 1_000);
    });
    expect(state()).toBe("shown");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(state()).toBe("hidden");
  });
});
