import { describe, expect, it } from "vitest";
import { POLL_INTERVAL, pollWhilePending } from "@/lib/queries/constants";

const query = (pending: boolean, dataUpdateCount = 1) => ({
  state: { dataUpdateCount, data: pending ? { pending: true as const } : {} },
});

describe("pollWhilePending", () => {
  it("does not poll when not pending", () => {
    expect(pollWhilePending(query(false), false)).toBe(false);
  });

  it("exponential backoff while pending, gives up after eight tries", () => {
    const q = { state: { dataUpdateCount: 1, data: { pending: true as const } } };
    expect(pollWhilePending(q, true)).toBe(POLL_INTERVAL.pending);
    q.state.dataUpdateCount = 2;
    expect(pollWhilePending(q, true)).toBe(2 * POLL_INTERVAL.pending);
    for (let n = 3; n <= 8; n++) {
      q.state.dataUpdateCount = n;
      expect(pollWhilePending(q, true)).not.toBe(false);
    }
    q.state.dataUpdateCount = 9;
    expect(pollWhilePending(q, true)).toBe(false);
  });

  // Must be the same query object: counts live in a WeakMap keyed by the query instance.
  it("counting restarts after pending clears", () => {
    const q = query(true, 1);
    expect(pollWhilePending(q, true)).toBe(POLL_INTERVAL.pending);
    q.state.dataUpdateCount = 5;
    expect(pollWhilePending(q, true)).not.toBe(POLL_INTERVAL.pending); // already backed off
    q.state.dataUpdateCount = 6;
    expect(pollWhilePending(q, false)).toBe(false);
    q.state.dataUpdateCount = 7;
    expect(pollWhilePending(q, true)).toBe(POLL_INTERVAL.pending);
  });
});
