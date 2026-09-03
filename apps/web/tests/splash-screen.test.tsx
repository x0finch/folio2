import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离 SplashScreen 的三个外部 hook:路由恒 idle、文案回显 key、无更新中。
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => true }));
vi.mock("use-intl", () => ({ useTranslations: () => (k: string) => k }));
vi.mock("@/lib/pwa/service-worker", () => ({ useSplashUpdating: () => false }));

import { SplashScreen } from "@/routes/-root/splash";
import { SPLASH_EXIT_MS, SPLASH_MIN_MS } from "@/routes/-root/splash-lifecycle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function renderSplash() {
  return render(
    <SplashScreen>
      <div data-testid="page">page content</div>
    </SplashScreen>,
  );
}

describe("SplashScreen", () => {
  // 回归:早先 exit 那个 useEffect 依赖里带了 `exiting`,setExiting 一改它 → cleanup 把「520ms 后
  // 卸载」的定时器提前清掉、重跑又 early-return 不再重设 → released 永不为真 → 覆盖层留着挡点击。
  // 这里断言放行后覆盖层**真的从 DOM 消失**。
  it("放行后覆盖层从 DOM 卸载,不留隐形层挡点击", () => {
    const { container } = renderSplash();
    expect(container.querySelector("#app-splash")).toBeTruthy(); // 首帧覆盖层在

    // 分两步:先过最短可见 floor(phase→exit,退场 effect 排下「卸载」定时器,act 退出时 effect 落地),
    // 再过退场动画时长(卸载定时器触发)→ 覆盖层彻底从 DOM 消失。
    act(() => {
      vi.advanceTimersByTime(SPLASH_MIN_MS + 20);
    });
    expect(container.querySelector('#app-splash[data-exit="true"]')).toBeTruthy(); // 已进入退场
    act(() => {
      vi.advanceTimersByTime(SPLASH_EXIT_MS + 20);
    });
    expect(container.querySelector("#app-splash")).toBeNull(); // 已卸载,不再挡点击
  });

  // 核心:未放行时页面内容**不绘制**(visibility:hidden),没有东西能抢在覆盖层之前露脸;放行后可见。
  it("未放行时 children 隐藏(不绘制),放行后显示", () => {
    const { container, getByTestId } = renderSplash();
    // children 始终在 DOM(SSR/hydrate 照常),首帧其容器 visibility:hidden。
    expect(getByTestId("page")).toBeTruthy();
    const content = container.querySelector("#app-content") as HTMLElement;
    expect(content.style.visibility).toBe("hidden");

    // 退场一开始就露出(与覆盖层淡出交叉溶解),放行后常驻。
    act(() => {
      vi.advanceTimersByTime(SPLASH_MIN_MS + 20);
    });
    expect(content.style.visibility).toBe(""); // 已露出
  });
});
