import { describe, expect, it } from "vitest";
import { type UpdateContext, updateAction } from "@/lib/pwa/update-action";

// SW 更新动作的纯判定(测试缝,ADR 0051)。三条更新路径的分叉 + 首次安装不打扰。

const base: UpdateContext = { hasWaiting: false, hasController: false, context: "splash" };

describe("updateAction", () => {
  it("没有 waiting 新版 → none", () => {
    expect(updateAction({ ...base, hasController: true })).toBe("none");
    expect(updateAction({ ...base, context: "running", hasController: true })).toBe("none");
  });

  it("有 waiting 但没有旧 controller(首次安装)→ none(不打扰,让它自然接手)", () => {
    expect(updateAction({ ...base, hasWaiting: true })).toBe("none");
    expect(updateAction({ ...base, hasWaiting: true, context: "running" })).toBe("none");
  });

  it("闪屏语境 + 有 waiting + 有旧 controller → silent-activate(自动静默换版)", () => {
    expect(updateAction({ hasWaiting: true, hasController: true, context: "splash" })).toBe(
      "silent-activate",
    );
  });

  it("运行中语境 + 有 waiting + 有旧 controller → prompt(弹提示交给用户)", () => {
    expect(updateAction({ hasWaiting: true, hasController: true, context: "running" })).toBe(
      "prompt",
    );
  });
});
