import { describe, expect, it, vi } from "vitest";
import { LOG_LEVELS, resolveLogLevel } from "@/lib/server/entry/log-level";

describe("resolveLogLevel", () => {
  it("valid levels pass through", () => {
    for (const level of LOG_LEVELS) {
      expect(resolveLogLevel(level)).toBe(level);
    }
  });

  it("unset: info", () => {
    expect(resolveLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel("")).toBe("info");
  });

  it('a misspelling like "warn": falls back to info and reports the ignored value', () => {
    const onUnknown = vi.fn();
    expect(resolveLogLevel("warn", onUnknown)).toBe("info");
    expect(onUnknown).toHaveBeenCalledWith("warn");
  });

  it("case is not forgiven: lowercase only", () => {
    const onUnknown = vi.fn();
    expect(resolveLogLevel("INFO", onUnknown)).toBe("info");
    expect(onUnknown).toHaveBeenCalledWith("INFO");
  });

  it("completely unintelligible values also just fall back to info, no throw", () => {
    expect(() => resolveLogLevel("loud")).not.toThrow();
    expect(resolveLogLevel("loud")).toBe("info");
  });
});
