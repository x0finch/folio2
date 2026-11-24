import { describe, expect, it } from "vitest";
import { type SplashInput, splashPhase } from "@/routes/-root/splash-lifecycle";

const base: SplashInput = {
  hydrated: false,
  routerIdle: false,
  minElapsed: false,
  maxElapsed: false,
  updating: false,
};

describe("splashPhase", () => {
  it("SSR first frame / not hydrated: preparing", () => {
    expect(splashPhase(base)).toBe("preparing");
    expect(splashPhase({ ...base, routerIdle: true, minElapsed: true })).toBe("preparing");
  });

  it("hydrated, router not settled: loading", () => {
    expect(splashPhase({ ...base, hydrated: true })).toBe("loading");
    expect(splashPhase({ ...base, hydrated: true, routerIdle: true })).toBe("loading");
    expect(splashPhase({ ...base, hydrated: true, minElapsed: true })).toBe("loading");
  });

  it("hydrated + router idle + minimum visible time elapsed: release", () => {
    expect(splashPhase({ ...base, hydrated: true, routerIdle: true, minElapsed: true })).toBe(
      "exit",
    );
  });

  it("hard timeout fallback: release (even if the router has not settled)", () => {
    expect(splashPhase({ ...base, hydrated: true, maxElapsed: true })).toBe("exit");
  });

  it("updating takes unconditional priority: updating (overrides everything)", () => {
    expect(splashPhase({ ...base, updating: true })).toBe("updating");
    expect(
      splashPhase({
        hydrated: true,
        routerIdle: true,
        minElapsed: true,
        maxElapsed: true,
        updating: true,
      }),
    ).toBe("updating");
  });
});
