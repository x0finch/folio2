import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  it("after release the overlay is unmounted from the DOM, leaving no invisible layer blocking clicks", () => {
    const { container } = renderSplash();
    expect(container.querySelector("#app-splash")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(SPLASH_MIN_MS + 20);
    });
    expect(container.querySelector('#app-splash[data-exit="true"]')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(SPLASH_EXIT_MS + 20);
    });
    expect(container.querySelector("#app-splash")).toBeNull();
  });

  it("children hidden (not painted) until released, shown after release", () => {
    const { container, getByTestId } = renderSplash();
    expect(getByTestId("page")).toBeTruthy();
    const content = container.querySelector("#app-content") as HTMLElement;
    expect(content.style.visibility).toBe("hidden");

    act(() => {
      vi.advanceTimersByTime(SPLASH_MIN_MS + 20);
    });
    expect(content.style.visibility).toBe("");
  });
});
