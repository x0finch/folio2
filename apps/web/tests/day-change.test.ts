import { describe, expect, it } from "vitest";
import { computeDayChange } from "../src/lib/day-change";
import type { HistoryPoint } from "../src/lib/history";

const H = 60 * 60 * 1000;
const p = (tHoursAgo: number, total: number, now: number): HistoryPoint => ({
  t: now - tHoursAgo * H,
  total,
});

describe("computeDayChange", () => {
  const now = 1_000_000_000_000;

  it("uses the point nearest to ~24h ago", () => {
    const series = [p(48, 800, now), p(25, 900, now), p(1, 1200, now)];
    // 最接近 now-24h 的是 25h 前那点(900);change = 1200 - 900 = 300
    expect(computeDayChange(series, 1200, now)).toBe(300);
  });

  it("returns null when no point within the window", () => {
    // 只有很近(1h)和很远(72h)的点,none 落在 24h±18h 窗口
    const series = [p(72, 500, now), p(1, 1200, now)];
    expect(computeDayChange(series, 1200, now)).toBeNull();
  });

  it("returns null for empty series", () => {
    expect(computeDayChange([], 1200, now)).toBeNull();
  });

  it("negative change when portfolio dropped", () => {
    const series = [p(24, 1500, now)];
    expect(computeDayChange(series, 1200, now)).toBe(-300);
  });

  it("respects a custom window", () => {
    const series = [p(30, 1000, now)]; // 30h ago
    expect(computeDayChange(series, 1100, now, 4 * H)).toBeNull(); // |30h-24h|=6h > 4h
    expect(computeDayChange(series, 1100, now, 8 * H)).toBe(100); // 6h <= 8h
  });
});
