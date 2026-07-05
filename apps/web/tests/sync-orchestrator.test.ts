import { describe, expect, it } from "vitest";
import { orchestrateSync, type SyncItem, type SyncProgress } from "../src/lib/sync-orchestrator";

const items = (n: number): SyncItem[] =>
  Array.from({ length: n }, (_, i) => ({ accountId: `a${i}`, label: `A${i}` }));
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("orchestrateSync", () => {
  it("caps concurrency at the limit", async () => {
    let active = 0;
    let peak = 0;
    const worker = async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
    };
    const res = await orchestrateSync(items(9), worker, { concurrency: 3 });
    expect(peak).toBe(3); // 9 > 3 → 池会填满到 3,但绝不超过
    expect(res.done).toBe(9);
    expect(res.total).toBe(9);
  });

  it("collects failures without stopping the rest", async () => {
    const list: SyncItem[] = [
      { accountId: "ok1", label: "OK1" },
      { accountId: "bad", label: "BAD" },
      { accountId: "ok2", label: "OK2" },
    ];
    const worker = async (id: string) => {
      if (id === "bad") throw new Error("boom");
    };
    const res = await orchestrateSync(list, worker, { concurrency: 2 });
    expect(res.done).toBe(3); // 失败也算完成,其余照常
    expect(res.failures).toEqual([{ label: "BAD", error: "boom" }]);
  });

  it("empty list resolves immediately with zeroed progress", async () => {
    const res = await orchestrateSync([], async () => {}, {});
    expect(res).toEqual({ total: 0, done: 0, inFlight: [], failures: [] });
  });

  it("reports progress: inFlight tracked, done monotonic to total", async () => {
    const calls: SyncProgress[] = [];
    let prevDone = 0;
    const res = await orchestrateSync(items(5), async () => await delay(2), {
      concurrency: 2,
      onProgress: (p) => {
        expect(p.done).toBeGreaterThanOrEqual(prevDone); // 单调不减
        prevDone = p.done;
        expect(p.inFlight.length).toBeLessThanOrEqual(2); // 与并发上限一致
        calls.push(p);
      },
    });
    expect(res.done).toBe(5);
    expect(calls.some((c) => c.inFlight.length > 0)).toBe(true); // 中途确有在飞
    expect(calls.at(-1)?.inFlight).toEqual([]); // 收尾清空
  });
});
