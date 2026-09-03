import { describe, expect, it } from "vitest";
import { isNewerVersion, parseSwBuild } from "../src/lib/pwa/version";

// 更新检测的纯判定(ADR 0051 的「诚实·联网总是最新」模型)。取代旧的 update-action 测:更新流不再靠
// SW 的 waiting 竞态,而是「线上 sw.js 的 @sw-build ↔ 本次加载的 __APP_VERSION__」直比版本号。

describe("parseSwBuild", () => {
  it("取出戳进 sw.js 的构建版本", () => {
    expect(parseSwBuild("// @sw-build v0.14.0-27-g6db1271\nconst CACHE=1;")).toBe(
      "v0.14.0-27-g6db1271",
    );
  });

  it("未构建(占位原文)→ 原样返回占位串(由 isNewerVersion 当「无」处理)", () => {
    expect(parseSwBuild("// @sw-build __SW_BUILD__")).toBe("__SW_BUILD__");
  });

  it("没有 @sw-build 行 → null", () => {
    expect(parseSwBuild("const CACHE='folio-shell-v2';")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("线上与在跑不同 → 有新版", () => {
    expect(isNewerVersion("v0.14.0-27", "v0.14.0-25")).toBe(true);
  });

  it("同版本 → 无新版(冷启动:network-first 已是最新)", () => {
    expect(isNewerVersion("v0.14.0-27", "v0.14.0-27")).toBe(false);
  });

  it("解析不到 / 占位 / dev → 无新版(不误报)", () => {
    expect(isNewerVersion(null, "v0.14.0-25")).toBe(false);
    expect(isNewerVersion("__SW_BUILD__", "v0.14.0-25")).toBe(false);
    expect(isNewerVersion("v0.14.0-27", "dev")).toBe(false);
    expect(isNewerVersion("v0.14.0-27", "")).toBe(false);
  });
});
