import { describe, expect, it } from "vitest";
import {
  dataFreshness,
  isDataStale,
  isSyncDue,
  SYNC_DUE_MS,
  SYNC_WARN_MS,
} from "@/lib/core/sync-status";

// Pure: fed lastSyncedAt + now, asserts exact boundaries without reading the wall clock.
const NOW = 1_700_000_000_000;

describe("dataFreshness", () => {
  it("never synced → never", () => {
    expect(dataFreshness(null, NOW)).toBe("never");
  });

  it("just synced (within 1 hour) → fresh", () => {
    expect(dataFreshness(NOW - SYNC_DUE_MS + 1, NOW)).toBe("fresh");
  });

  it("exactly 1 hour → still fresh (boundary exclusive)", () => {
    expect(dataFreshness(NOW - SYNC_DUE_MS, NOW)).toBe("fresh");
  });

  it("just past 1 hour, under 26 → syncDue", () => {
    expect(dataFreshness(NOW - SYNC_DUE_MS - 1, NOW)).toBe("syncDue");
  });

  it("exactly 26 hours → still syncDue (boundary exclusive)", () => {
    expect(dataFreshness(NOW - SYNC_WARN_MS, NOW)).toBe("syncDue");
  });

  it("just past 26 hours → stale", () => {
    expect(dataFreshness(NOW - SYNC_WARN_MS - 1, NOW)).toBe("stale");
  });

  it("42 hours ago (the production bug's scenario) → stale", () => {
    expect(dataFreshness(NOW - 42 * 60 * 60 * 1000, NOW)).toBe("stale");
  });

  it("future timestamp (clock skew) → fresh, not treated as expired", () => {
    expect(dataFreshness(NOW + 60 * 60 * 1000, NOW)).toBe("fresh");
  });
});

describe("isDataStale (pill turns amber)", () => {
  it("true only in the stale tier", () => {
    expect(isDataStale(null, NOW)).toBe(false); // never-synced is handled by attention, not here
    expect(isDataStale(NOW - SYNC_DUE_MS - 1, NOW)).toBe(false); // syncDue doesn't turn amber
    expect(isDataStale(NOW - SYNC_WARN_MS - 1, NOW)).toBe(true);
  });
});

describe("isSyncDue (auto-run a round)", () => {
  it("never synced also counts as due (a new user needs a first round)", () => {
    expect(isSyncDue(null, NOW)).toBe(true);
  });

  it("over 1 hour (stale included) is due; within 1 hour is not", () => {
    expect(isSyncDue(NOW - SYNC_DUE_MS, NOW)).toBe(false);
    expect(isSyncDue(NOW - SYNC_DUE_MS - 1, NOW)).toBe(true);
    expect(isSyncDue(NOW - SYNC_WARN_MS - 1, NOW)).toBe(true);
  });

  it("future timestamp is not due", () => {
    expect(isSyncDue(NOW + 1, NOW)).toBe(false);
  });
});
