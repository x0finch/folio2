import { describe, expect, it } from "vitest";
import { historyResolution } from "@/lib/core/history-range";

// 曲线读哪一档原料(FOL-91):≤ 7 天原始快照,更长读日汇总,1 年 / 全部再降采样。
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("historyResolution", () => {
  it("显式 range:7d 原始点,30d 日汇总,1y / all 降采样", () => {
    expect(historyResolution({ range: "7d" })).toBe("hourly");
    expect(historyResolution({ range: "30d" })).toBe("daily");
    expect(historyResolution({ range: "1y" })).toBe("sampled");
    expect(historyResolution({ range: "all" })).toBe("sampled");
  });

  it("只给 since:按跨度判,7 天整不算长窗", () => {
    expect(historyResolution({ since: NOW - 7 * DAY, nowMs: NOW })).toBe("hourly");
    expect(historyResolution({ since: NOW - 7 * DAY - 1, nowMs: NOW })).toBe("daily");
    expect(historyResolution({ since: NOW - 364 * DAY, nowMs: NOW })).toBe("daily");
    expect(historyResolution({ since: NOW - 365 * DAY, nowMs: NOW })).toBe("sampled");
    expect(historyResolution({ nowMs: NOW })).toBe("sampled");
  });
});
