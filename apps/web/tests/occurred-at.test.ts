import { describe, expect, it } from "vitest";
import { OccurredAt } from "@/lib/server/manual-activities/occurred-at";

// Allowed range for a manual activity timestamp.
describe("OccurredAt", () => {
  const ok = (ms: number) => OccurredAt.safeParse(ms).success;

  it("past time -> accepted (backfilling is normal)", () => {
    expect(ok(Date.now() - 365 * 24 * 3600_000)).toBe(true);
    expect(ok(0)).toBe(true);
  });

  it("just now -> accepted", () => {
    expect(ok(Date.now())).toBe(true);
  });

  it("slightly fast client clock (one minute ahead) -> still accepted", () => {
    // A strict cutoff would reject "just recorded" entries with no actionable explanation.
    expect(ok(Date.now() + 60_000)).toBe(true);
  });

  it("tomorrow / next year -> rejected", () => {
    expect(ok(Date.now() + 24 * 3600_000)).toBe(false);
    expect(ok(Date.now() + 365 * 24 * 3600_000)).toBe(false);
  });

  it("fractional -> rejected (timestamps are whole ms)", () => {
    expect(ok(1.5)).toBe(false);
  });
});
