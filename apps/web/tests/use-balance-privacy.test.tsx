import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDE_BALANCES_CACHE_KEY, REVEAL_IDLE_MS } from "@/lib/hooks/balance-privacy";
import { BalancePrivacyProvider, useBalancePrivacy } from "@/lib/hooks/use-balance-privacy";

// 余额隐私 Provider 的**接线**(FOL-75,ADR 0052)。纯状态机在 balance-privacy.test.ts 里测过了,
// 这组盯的是它和外界之间的那几根线:
//   · 冷启动读 localStorage 缓存当初值(没缓存 → 先遮,fail-closed;缓存 OFF → 不遮、不闪)
//   · 服务器权威值到位 → 校准 + 写回缓存
//   · 「离开」信号(切后台 / 失焦)与 15 秒空闲 → 收回临时显示;有动作就重置空闲计时
//   · 没有 Provider 的孤立渲染 → 不遮,不抛
// 观察面是一个探针组件:它只把 hook 的 `hidden` 写出来,并给一个按钮调 `reveal`。

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

describe("冷启动:缓存决定初值", () => {
  it("没有 Provider → 不遮(孤立渲染的组件不该被糊掉,也不该抛)", () => {
    render(<Probe />);
    expect(state()).toBe("shown");
  });

  it("没缓存、服务器值还没到 → 先遮(fail-closed)", () => {
    mount(undefined);
    expect(state()).toBe("hidden");
  });

  it("缓存是 OFF、服务器值还没到 → 直接不遮,不闪那一下", () => {
    localStorage.setItem(HIDE_BALANCES_CACHE_KEY, "0");
    mount(undefined);
    expect(state()).toBe("shown");
  });

  it("读缓存抛异常(隐私窗口)→ 当没缓存,fail-closed,不崩", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount(undefined);
    expect(state()).toBe("hidden");
  });
});

describe("服务器权威值:校准 + 写回缓存", () => {
  it("服务器说关 → 不遮,并把 OFF 写回缓存(下次冷启动不闪)", () => {
    mount(false);
    expect(state()).toBe("shown");
    expect(localStorage.getItem(HIDE_BALANCES_CACHE_KEY)).toBe("0");
  });

  it("缓存说关、服务器说开 → 以服务器为准改成遮,缓存同步成 ON", () => {
    localStorage.setItem(HIDE_BALANCES_CACHE_KEY, "0");
    mount(true);
    expect(state()).toBe("hidden");
    expect(localStorage.getItem(HIDE_BALANCES_CACHE_KEY)).toBe("1");
  });

  it("权威值从开变关 → 立即不遮", () => {
    const m = mount(true);
    expect(state()).toBe("hidden");
    m.rerenderWith(false);
    expect(state()).toBe("shown");
    expect(localStorage.getItem(HIDE_BALANCES_CACHE_KEY)).toBe("0");
  });

  it("写缓存抛异常 → 吞掉,页面照常", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    mount(true);
    expect(state()).toBe("hidden");
  });
});

describe("临时显示与收回", () => {
  it("点一下 → 临时显示", () => {
    mount(true);
    fireEvent.click(screen.getByRole("button"));
    expect(state()).toBe("shown");
  });

  it("窗口失焦 → 收回", () => {
    mount(true);
    fireEvent.click(screen.getByRole("button"));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(state()).toBe("hidden");
  });

  it("切后台(visibilitychange → hidden)→ 收回;回到前台那一下不算", () => {
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

  it("空闲到点 → 自动收回", () => {
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

  it("中途有动作 → 空闲计时从头算(真·空闲才收回)", () => {
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
    expect(state()).toBe("shown"); // 没有那次 mousemove 的话这时早该收回了
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(state()).toBe("hidden");
  });
});
