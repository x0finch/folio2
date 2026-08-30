import { describe, expect, it } from "vitest";
import { POLL_INTERVAL, pollWhilePending } from "@/lib/queries/constants";

const query = (pending: boolean, dataUpdateCount = 1) => ({
  state: { dataUpdateCount, data: pending ? { pending: true as const } : {} },
});

describe("pollWhilePending", () => {
  it("非 pending 时不轮询", () => {
    expect(pollWhilePending(query(false), false)).toBe(false);
  });

  it("pending 时第一发就是 POLL_INTERVAL.pending", () => {
    expect(pollWhilePending(query(true), true)).toBe(POLL_INTERVAL.pending);
  });

  it("pending 时指数退避,八次后放弃", () => {
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

  it("pending 消失后下轮从头数", () => {
    const q = query(true);
    pollWhilePending(q, true);
    expect(pollWhilePending(query(false), false)).toBe(false);
    expect(pollWhilePending(query(true), true)).toBe(POLL_INTERVAL.pending);
  });
});
