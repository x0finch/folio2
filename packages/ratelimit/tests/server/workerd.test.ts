import { beforeEach, describe, expect, it } from "vitest";
import {
  bypassGatesForTests,
  defineRateLimit,
  resetGatesForTests,
  withRetry,
} from "../../src/index";

// 在真 workerd 里验「运行时承诺」。**这里用真时钟真等**(几十毫秒级)—— 用假时钟就等于回到
// node 那一档,把要验的东西验掉了。
//
// 覆盖的是三件在 node 上恒成立、在 Workers 上不是白给的事:
//   ① p-throttle 能 import(`rate-limiter-flexible` 在这一步就让 workerd 段错误)
//   ② setTimeout / Date.now 老实推进 —— 限速全靠它俩
//   ③ 模块级状态在 isolate 内跨调用存活 —— 那是「同 key 同队」的物理基础

const INTERVAL = 60;

beforeEach(() => {
  resetGatesForTests();
  bypassGatesForTests(false); // 这一档就是要看真闸,别旁路
});

describe("运行时承诺", () => {
  it("**默认档的 Cache API 在这里是真的** —— node 上只能退回本地,验不到这一层", async () => {
    const key = `wd-cache-${Math.round(Date.now())}`;
    // 不传 store = 默认 cache。第一发把时隙播进缓存。
    await defineRateLimit({ key, limit: 1, interval: 5000 })(async () => {});

    // 清掉本地那层,模拟「换了个 isolate」:冷启时应该把刚才那个时隙从缓存读回来,于是照样得等,
    // 而不是白给一整轮突发。**这正是默认不用内存的理由。**
    resetGatesForTests();
    bypassGatesForTests(false);
    let askedToWait = -1;
    await defineRateLimit({
      key,
      limit: 1,
      interval: 5000,
      sleep: async (ms) => {
        askedToWait = ms; // 不真等 5 秒,记下「被要求等多久」——那个数就是证据
      },
    })(async () => {});
    expect(askedToWait).toBeGreaterThan(1000);
  });

  it("setTimeout 之后 Date.now 真的走了(限速的全部依据)", async () => {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, INTERVAL));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(INTERVAL - 10);
  });

  it("真闸摊开请求 —— 不是在 node 上摊开,是在这里", async () => {
    const gate = defineRateLimit({ key: "wd", limit: 1, interval: INTERVAL });
    const at: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () => gate(async () => void at.push(Date.now() - t0))),
    );
    at.sort((a, b) => a - b);
    expect(at[0]).toBeLessThan(INTERVAL / 2); // 第一发不等
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThan(INTERVAL * 0.6); // 后面每发各占一个窗口
    }
  });

  it("同 key 的两个 defineRateLimit 共享一个队(模块级状态活着)", async () => {
    const opts = { key: "wd2", limit: 1, interval: INTERVAL };
    const t0 = Date.now();
    await defineRateLimit(opts)(async () => {});
    await defineRateLimit(opts)(async () => {});
    expect(Date.now() - t0).toBeGreaterThan(INTERVAL * 0.6);
  });

  it("不同 key 不互相等", async () => {
    const t0 = Date.now();
    await Promise.all([
      defineRateLimit({ key: "a", limit: 1, interval: 5000 })(async () => {}),
      defineRateLimit({ key: "b", limit: 1, interval: 5000 })(async () => {}),
    ]);
    expect(Date.now() - t0).toBeLessThan(INTERVAL);
  });

  it("withRetry 的等待在这里也真的等(它用的是同一套定时器)", async () => {
    let calls = 0;
    const t0 = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error("429"), { retryable: true, retryAfterMs: INTERVAL });
        return "ok";
      },
      { attempts: 2, maxWaitMs: 1000, baseMs: 1 },
    );
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(INTERVAL - 10);
  });
});
