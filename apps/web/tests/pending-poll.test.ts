import { describe, expect, it } from "vitest";
import { POLL_INTERVAL, pollWhilePending } from "@/lib/queries/constants";

const query = (pending: boolean, dataUpdateCount = 1) => ({
  state: { dataUpdateCount, data: pending ? { pending: true as const } : {} },
});

describe("pollWhilePending", () => {
  it("非 pending 时不轮询", () => {
    expect(pollWhilePending(query(false), false)).toBe(false);
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

  // 必须是**同一个** query 对象:计数记在以 query 实例为键的 WeakMap 上,换个新对象就从没进过
  // 那张表,「pending 消失 → 清记录」那条路根本没跑。
  it("pending 消失后下轮从头数", () => {
    const q = query(true, 1);
    expect(pollWhilePending(q, true)).toBe(POLL_INTERVAL.pending);
    q.state.dataUpdateCount = 5;
    expect(pollWhilePending(q, true)).not.toBe(POLL_INTERVAL.pending); // 已退避了几档
    q.state.dataUpdateCount = 6;
    expect(pollWhilePending(q, false)).toBe(false);
    q.state.dataUpdateCount = 7;
    expect(pollWhilePending(q, true)).toBe(POLL_INTERVAL.pending);
  });
});
