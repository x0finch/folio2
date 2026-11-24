import { describe, expect, it } from "vitest";
import { parseIdleTimeout, shouldLock } from "@/lib/hooks/idle-lock";

describe("shouldLock", () => {
  const active = 1_000_000;
  const FIVE_MIN = 5 * 60 * 1000;

  it("just active (elapsed 0): no lock", () => {
    expect(shouldLock({ lastActiveAt: active, now: active, timeoutMs: FIVE_MIN })).toBe(false);
  });

  it("before the deadline (elapsed < timeout): no lock", () => {
    expect(
      shouldLock({ lastActiveAt: active, now: active + FIVE_MIN - 1, timeoutMs: FIVE_MIN }),
    ).toBe(false);
  });

  it("exactly at the deadline (elapsed == timeout): locks", () => {
    expect(shouldLock({ lastActiveAt: active, now: active + FIVE_MIN, timeoutMs: FIVE_MIN })).toBe(
      true,
    );
  });

  it("past the deadline (elapsed > timeout): locks", () => {
    expect(
      shouldLock({ lastActiveAt: active, now: active + 2 * FIVE_MIN, timeoutMs: FIVE_MIN }),
    ).toBe(true);
  });

  it("timeoutMs = null (never): never locks however long", () => {
    expect(
      shouldLock({ lastActiveAt: active, now: active + 999 * FIVE_MIN, timeoutMs: null }),
    ).toBe(false);
  });

  it("clock moved backwards (now < lastActiveAt): conservatively no lock", () => {
    expect(shouldLock({ lastActiveAt: active, now: active - 5000, timeoutMs: FIVE_MIN })).toBe(
      false,
    );
  });
});

//
const DEFAULT_MS = 15 * 60_000;

describe("parseIdleTimeout", () => {
  it("minute options to milliseconds", () => {
    expect(parseIdleTimeout("1")).toBe(60_000);
    expect(parseIdleTimeout("5")).toBe(300_000);
    expect(parseIdleTimeout("15")).toBe(900_000);
    expect(parseIdleTimeout("30")).toBe(1_800_000);
  });

  it('old never value: default tier (no longer means "never")', () => {
    expect(parseIdleTimeout("never")).toBe(DEFAULT_MS);
  });

  it("missing (null): default tier", () => {
    expect(parseIdleTimeout(null)).toBe(DEFAULT_MS);
  });

  it("invalid value: falls back to the default tier", () => {
    expect(parseIdleTimeout("7")).toBe(DEFAULT_MS);
    expect(parseIdleTimeout("abc")).toBe(DEFAULT_MS);
    expect(parseIdleTimeout("")).toBe(DEFAULT_MS);
  });
});
