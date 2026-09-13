import { describe, expect, it } from "vitest";
import {
  dataFreshness,
  isDataStale,
  isSyncDue,
  SYNC_DUE_MS,
  SYNC_WARN_MS,
} from "@/lib/core/sync-status";

// 组合级新鲜度(FOL-18 子票 1)。纯函数,只喂 lastSyncedAt + now,断言精确边界 —— 不读墙钟。
const NOW = 1_700_000_000_000;

describe("dataFreshness", () => {
  it("从没同步过 → never", () => {
    expect(dataFreshness(null, NOW)).toBe("never");
  });

  it("刚同步(1 小时内)→ fresh", () => {
    expect(dataFreshness(NOW - SYNC_DUE_MS + 1, NOW)).toBe("fresh");
  });

  it("恰好卡在 1 小时 → 还是 fresh(边界不含)", () => {
    expect(dataFreshness(NOW - SYNC_DUE_MS, NOW)).toBe("fresh");
  });

  it("刚过 1 小时、没到 26 → syncDue", () => {
    expect(dataFreshness(NOW - SYNC_DUE_MS - 1, NOW)).toBe("syncDue");
  });

  it("恰好卡在 26 小时 → 还是 syncDue(边界不含)", () => {
    expect(dataFreshness(NOW - SYNC_WARN_MS, NOW)).toBe("syncDue");
  });

  it("刚过 26 小时 → stale", () => {
    expect(dataFreshness(NOW - SYNC_WARN_MS - 1, NOW)).toBe("stale");
  });

  it("42 小时前(那个线上 bug 的场景)→ stale", () => {
    expect(dataFreshness(NOW - 42 * 60 * 60 * 1000, NOW)).toBe("stale");
  });

  it("未来时间戳(时钟偏移)→ fresh,不把未来当过期", () => {
    expect(dataFreshness(NOW + 60 * 60 * 1000, NOW)).toBe("fresh");
  });
});

describe("isDataStale(药丸转黄)", () => {
  it("只在 stale 一档为真", () => {
    expect(isDataStale(null, NOW)).toBe(false); // 从未同步交给 attention,不走这条
    expect(isDataStale(NOW - SYNC_DUE_MS - 1, NOW)).toBe(false); // syncDue 不转黄
    expect(isDataStale(NOW - SYNC_WARN_MS - 1, NOW)).toBe(true);
  });
});

describe("isSyncDue(自动补一轮)", () => {
  it("从没同步过也算 due(新用户接完账户回首页要跑第一轮)", () => {
    expect(isSyncDue(null, NOW)).toBe(true);
  });

  it("超过 1 小时(含 stale)算 due,1 小时内不算", () => {
    expect(isSyncDue(NOW - SYNC_DUE_MS, NOW)).toBe(false);
    expect(isSyncDue(NOW - SYNC_DUE_MS - 1, NOW)).toBe(true);
    expect(isSyncDue(NOW - SYNC_WARN_MS - 1, NOW)).toBe(true);
  });

  it("未来时间戳不算 due", () => {
    expect(isSyncDue(NOW + 1, NOW)).toBe(false);
  });
});
