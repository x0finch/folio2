import { describe, expect, it } from "vitest";
import { historyResolution } from "@/lib/core/history-range";

// ≤ 7 days reads raw snapshots, longer reads daily rollups, 1y / all are downsampled further.
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe("historyResolution", () => {
  it("explicit range: 7d raw, 30d daily, 1y / all downsampled", () => {
    expect(historyResolution({ range: "7d" })).toBe("hourly");
    expect(historyResolution({ range: "30d" })).toBe("daily");
    expect(historyResolution({ range: "1y" })).toBe("sampled");
    expect(historyResolution({ range: "all" })).toBe("sampled");
  });

  it("only since: judged by span; exactly 7 days isn't a long window", () => {
    expect(historyResolution({ since: NOW - 7 * DAY, nowMs: NOW })).toBe("hourly");
    expect(historyResolution({ since: NOW - 7 * DAY - 1, nowMs: NOW })).toBe("daily");
    expect(historyResolution({ since: NOW - 364 * DAY, nowMs: NOW })).toBe("daily");
    expect(historyResolution({ since: NOW - 365 * DAY, nowMs: NOW })).toBe("sampled");
    expect(historyResolution({ nowMs: NOW })).toBe("sampled");
  });
});
