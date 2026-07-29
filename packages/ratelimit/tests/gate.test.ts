import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bypassGatesForTests, defineRateLimit, resetGatesForTests } from "../src/index";

// 限速本身是 p-throttle 的活,这里测的是本包加的那两件事:**按 key 分队**、**队列住在模块级**。
// 用假时钟推进而不是真等 —— p-throttle 用的是 setTimeout,vitest 的 fake timer 接得住(实测)。

beforeEach(() => {
  resetGatesForTests();
  bypassGatesForTests(false);
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// 把 n 个请求丢进闸,返回「各自在什么时刻被放行」(相对起点的毫秒)。
async function releaseTimes(
  gate: ReturnType<typeof defineRateLimit>,
  n: number,
  subKeys?: string[],
): Promise<number[]> {
  const t0 = Date.now();
  const at: number[] = [];
  const all = Promise.all(
    Array.from({ length: n }, (_, i) =>
      gate(async () => void at.push(Date.now() - t0), subKeys?.[i]),
    ),
  );
  await vi.runAllTimersAsync();
  await all;
  return at.sort((a, b) => a - b);
}

describe("按 key 分队", () => {
  it("同 key 的请求排一个队,按 limit/interval 摊开", async () => {
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 100 });
    expect(await releaseTimes(gate, 4)).toEqual([0, 100, 200, 300]);
  });

  it("limit > 1 时允许突发,超出的才排队", async () => {
    const gate = defineRateLimit({ key: "k", limit: 3, interval: 100 });
    const at = await releaseTimes(gate, 5);
    expect(at.slice(0, 3)).toEqual([0, 0, 0]); // 头 3 发一起走
    expect(at[3]).toBeGreaterThanOrEqual(100); // 第 4 发等下一个窗口
  });

  it("不同 key 互不影响 —— 各自的第一发都不等", async () => {
    const a = defineRateLimit({ key: "a", limit: 1, interval: 100 });
    const b = defineRateLimit({ key: "b", limit: 1, interval: 100 });
    const t0 = Date.now();
    await Promise.all([a(async () => {}), b(async () => {})]);
    expect(Date.now() - t0).toBe(0);
  });

  it("subKey 分队 —— 每账户自带额度的上游用它", async () => {
    const gate = defineRateLimit({ key: "cex", limit: 1, interval: 100 });
    // 两个账户各一发 → 都不等;同一个账户的第二发才排队
    expect(await releaseTimes(gate, 3, ["a1", "a2", "a1"])).toEqual([0, 0, 100]);
  });
});

describe("队列住在模块级 —— 限速真正生效的前提", () => {
  it("两次 defineRateLimit 同 key → 同一个队(否则并发调用者各自满速,等于没限)", async () => {
    const opts = { key: "same", limit: 1, interval: 100 };
    const first = defineRateLimit(opts);
    const second = defineRateLimit(opts);
    const t0 = Date.now();
    const at: number[] = [];
    const all = Promise.all([
      first(async () => void at.push(Date.now() - t0)),
      second(async () => void at.push(Date.now() - t0)),
    ]);
    await vi.runAllTimersAsync();
    await all;
    expect(at.sort((a, b) => a - b)).toEqual([0, 100]); // 第二个排在第一个后面
  });
});

describe("闸只管发送频率", () => {
  it("不串行化请求本身 —— 额度内的并发请求同时在飞", async () => {
    const gate = defineRateLimit({ key: "k", limit: 5, interval: 1000 });
    const t0 = Date.now();
    const done: number[] = [];
    const all = Promise.all(
      Array.from({ length: 5 }, () =>
        gate(async () => {
          await new Promise((r) => setTimeout(r, 200));
          done.push(Date.now() - t0);
        }),
      ),
    );
    await vi.runAllTimersAsync();
    await all;
    // 5 个各 200ms,若被串行化就是 1000ms;并行则都在 200ms 附近结束
    expect(Math.max(...done)).toBeLessThan(400);
  });

  it("请求抛错不卡住后面的", async () => {
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 100 });
    const first = gate(async () => {
      throw new Error("boom");
    }).catch((e) => (e as Error).message);
    const second = gate(async () => "ok");
    await vi.runAllTimersAsync();
    expect(await first).toBe("boom");
    expect(await second).toBe("ok");
  });
});

describe("说不通的配置立刻炸,不悄悄退化", () => {
  it.each([0, -1, 1.5])("limit = %p → 抛", (limit) => {
    expect(() => defineRateLimit({ key: "bad", limit, interval: 100 })).toThrow(/limit/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("interval = %p → 抛", (interval) => {
    expect(() => defineRateLimit({ key: "bad", limit: 1, interval })).toThrow(/interval/);
  });

  it("正常配置不抛(免得上面几条是靠「什么都抛」通过的)", () => {
    expect(() => defineRateLimit({ key: "ok", limit: 1, interval: 100 })).not.toThrow();
    expect(() => defineRateLimit({ key: "ok", limit: 500, interval: 60_000 })).not.toThrow();
  });
});

describe("测试旁路", () => {
  it("开了之后直接放行,一次都不等(集成测试用)", async () => {
    bypassGatesForTests(true);
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 10_000 });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 10 }, () => gate(async () => {})));
    expect(Date.now() - t0).toBe(0);
  });

  it("旁路不吞返回值,也不吞异常", async () => {
    bypassGatesForTests(true);
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 10_000 });
    expect(await gate(async () => 42)).toBe(42);
    await expect(
      gate(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
