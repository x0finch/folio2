import { describe, expect, it } from "vitest";
import { type SplashInput, splashPhase } from "@/routes/-root/splash-lifecycle";

// 闪屏生命周期的纯判定(测试缝,见 ADR 0051 / 对齐 sw-route.test.ts)。
// 组件只喂输入 + 渲染;所有「准备中→加载中→放行/更新中」的时序在这里穷举。

const base: SplashInput = {
  hydrated: false,
  routerIdle: false,
  minElapsed: false,
  maxElapsed: false,
  updating: false,
};

describe("splashPhase", () => {
  it("SSR 首帧 / 未 hydrate → 准备中", () => {
    expect(splashPhase(base)).toBe("preparing");
    // 即便路由已 idle,只要还没 hydrate 仍是准备中(SSR 那一态)
    expect(splashPhase({ ...base, routerIdle: true, minElapsed: true })).toBe("preparing");
  });

  it("已 hydrate、路由还没 settle → 加载中", () => {
    expect(splashPhase({ ...base, hydrated: true })).toBe("loading");
    // 路由 idle 但最短可见还没到 → 仍加载中(不早放)
    expect(splashPhase({ ...base, hydrated: true, routerIdle: true })).toBe("loading");
    // 过了 floor 但路由还 pending → 仍加载中(等骨架就位)
    expect(splashPhase({ ...base, hydrated: true, minElapsed: true })).toBe("loading");
  });

  it("hydrate + 路由 idle + 过了最短可见 → 放行", () => {
    expect(splashPhase({ ...base, hydrated: true, routerIdle: true, minElapsed: true })).toBe(
      "exit",
    );
  });

  it("硬超时兜底 → 放行(哪怕路由还没 settle)", () => {
    expect(splashPhase({ ...base, hydrated: true, maxElapsed: true })).toBe("exit");
  });

  it("updating 无条件优先 → 更新中(压过一切)", () => {
    expect(splashPhase({ ...base, updating: true })).toBe("updating");
    // 即便本该放行,换版时也显示更新中
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
