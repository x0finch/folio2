import { describe, expect, it, vi } from "vitest";
import { LOG_LEVELS, resolveLogLevel } from "../src/lib/server/log-level";

// LOG_LEVEL 是自托管者手写的,拼错很正常。以前非法值会被强转塞给 LogTape,导致每个 server function
// 都抛「Invalid log level」——站点整体 500,而原因只躺在日志里。这几条钉住「配错不该搞挂站点」。
describe("resolveLogLevel", () => {
  it("合法级别原样通过", () => {
    for (const level of LOG_LEVELS) {
      expect(resolveLogLevel(level)).toBe(level);
    }
  });

  it("没设 → info", () => {
    expect(resolveLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel("")).toBe("info");
  });

  // 这个拼法最容易犯:别的日志库大多叫 warn,LogTape 叫 warning。CI 上我自己就写错过一次。
  it("「warn」这种拼错 → 退回 info 并报出被忽略的值", () => {
    const onUnknown = vi.fn();
    expect(resolveLogLevel("warn", onUnknown)).toBe("info");
    expect(onUnknown).toHaveBeenCalledWith("warn");
  });

  it("大小写不糊弄过去 —— 只认小写", () => {
    const onUnknown = vi.fn();
    expect(resolveLogLevel("INFO", onUnknown)).toBe("info");
    expect(onUnknown).toHaveBeenCalledWith("INFO");
  });

  it("彻底看不懂的值也只是退回 info,不抛", () => {
    expect(() => resolveLogLevel("loud")).not.toThrow();
    expect(resolveLogLevel("loud")).toBe("info");
  });
});
