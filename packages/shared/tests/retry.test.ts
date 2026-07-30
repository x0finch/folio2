import { describe, expect, it } from "vitest";
import { withRetry } from "../src/index";

// 抖动源固定成 0.5,于是"等了多久"是可断言的数,不用容差。
const opts = (over: Partial<Parameters<typeof withRetry>[1]> = {}) => {
  const slept: number[] = [];
  return {
    slept,
    opts: {
      attempts: 3,
      maxWaitMs: 5000,
      baseMs: 200,
      random: () => 0.5,
      sleep: async (ms: number) => void slept.push(ms),
      ...over,
    },
  };
};

// 前 failTimes 次抛、之后成功。
function flaky(makeErr: () => unknown, failTimes: number) {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      if (calls <= failTimes) throw makeErr();
      return "ok";
    },
    calls: () => calls,
  };
}

const retryable = (extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("boom"), { retryable: true, ...extra });

describe("withRetry", () => {
  it("鸭子类型认 retryable —— 不要求继承某个错误基类", async () => {
    const { slept, opts: o } = opts();
    const { fn, calls } = flaky(() => retryable(), 1);
    expect(await withRetry(fn, o)).toBe("ok");
    expect(calls()).toBe(2);
    expect(slept).toHaveLength(1);
  });

  it("retryable 不为 true → 一次都不重试", async () => {
    const { slept, opts: o } = opts();
    const { fn, calls } = flaky(() => new Error("plain"), 99);
    await expect(withRetry(fn, o)).rejects.toThrow("plain");
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  it("优先采用 retryAfterMs,不用退避", async () => {
    const { slept, opts: o } = opts();
    const { fn } = flaky(() => retryable({ retryAfterMs: 1234 }), 1);
    await withRetry(fn, o);
    expect(slept).toEqual([1234 + 0.5 * 200]); // Retry-After + 抖动
  });

  it("没有 retryAfterMs → 指数退避,不是无限等", async () => {
    const { slept, opts: o } = opts();
    const { fn } = flaky(() => retryable(), 2);
    await withRetry(fn, o);
    // 200 * 2^0 = 200,200 * 2^1 = 400,各加 100 抖动
    expect(slept).toEqual([300, 500]);
  });

  it("退避也被 maxWaitMs 夹住", async () => {
    const { slept, opts: o } = opts({ attempts: 5, maxWaitMs: 500, baseMs: 200 });
    const { fn } = flaky(() => retryable(), 4);
    await withRetry(fn, o);
    // 200 / 400 / 500(被夹)/ 500(被夹),各加 100 抖动
    expect(slept).toEqual([300, 500, 600, 600]);
  });

  it("retryAfterMs 超过上限 → 默认不等,立刻抛,且错误上仍带着它供调用方决策", async () => {
    const { slept, opts: o } = opts();
    const { fn, calls } = flaky(() => retryable({ retryAfterMs: 60_000 }), 99);
    const err = await withRetry(fn, o).catch((e) => e);
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
    expect(err.retryAfterMs).toBe(60_000);
  });

  it('exceedsMaxWait: "clamp" → 夹到上限继续等(sync 迁移前就是这个行为)', async () => {
    const { slept, opts: o } = opts({ exceedsMaxWait: "clamp" });
    const { fn } = flaky(() => retryable({ retryAfterMs: 60_000 }), 1);
    await withRetry(fn, o);
    expect(slept).toEqual([5000 + 100]);
  });

  it("次数用尽 → 抛**最后一次**的错误,不是第一次的", async () => {
    const { opts: o } = opts();
    let n = 0;
    const fn = async () => {
      n++;
      throw retryable({ message: `fail-${n}` });
    };
    const err = await withRetry(fn, o).catch((e) => e);
    expect(n).toBe(3);
    expect(err.message).toBe("fail-3");
  });

  it("抖动幅度是 baseMs —— 同一个 Retry-After 的多个调用者不会同时醒", async () => {
    const { slept, opts: o } = opts({ random: () => 1 });
    const { fn } = flaky(() => retryable({ retryAfterMs: 1000 }), 1);
    await withRetry(fn, o);
    expect(slept).toEqual([1000 + 200]);
  });

  it("isRetryable 可覆盖 —— 迁移时用它把行为钉成迁移前的样子", async () => {
    const { opts: o } = opts({ isRetryable: () => false });
    const { fn, calls } = flaky(() => retryable(), 99);
    await expect(withRetry(fn, o)).rejects.toThrow();
    expect(calls()).toBe(1);
  });

  it("onRetry 每次重试前回调一次(sync 靠它打 warning 日志)", async () => {
    const seen: Array<{ attempt: number; waitMs: number }> = [];
    const { opts: o } = opts({
      onRetry: (i) => void seen.push({ attempt: i.attempt, waitMs: i.waitMs }),
    });
    const { fn } = flaky(() => retryable(), 2);
    await withRetry(fn, o);
    expect(seen).toEqual([
      { attempt: 1, waitMs: 300 },
      { attempt: 2, waitMs: 500 },
    ]);
  });

  it("attempts: 1 → 从不重试", async () => {
    const { slept, opts: o } = opts({ attempts: 1 });
    const { fn, calls } = flaky(() => retryable(), 99);
    await expect(withRetry(fn, o)).rejects.toThrow();
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });
});
