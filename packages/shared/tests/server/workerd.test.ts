import { beforeEach, describe, expect, it } from "vitest";
import {
  bypassRateLimitsForTests,
  defineRateLimit,
  resetRateLimitsForTests,
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
  resetRateLimitsForTests();
  bypassRateLimitsForTests(false); // 这一档就是要看真闸,别旁路
});

describe("运行时承诺", () => {
  it("**默认档的 Cache API 在这里是真的** —— node 上只能退回本地,验不到这一层", async () => {
    const key = `wd-cache-${Math.round(Date.now())}`;
    // 不传 store = 默认 cache。第一发把时隙播进缓存。
    await defineRateLimit({ key, limit: 1, interval: 5000 })(async () => {});

    // 清掉本地那层,模拟「换了个 isolate」:冷启时应该把刚才那个时隙从缓存读回来,于是照样得等,
    // 而不是白给一整轮突发。**这正是默认不用内存的理由。**
    resetRateLimitsForTests();
    bypassRateLimitsForTests(false);
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
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => gate(async () => {})));
    // 4 发过 limit-1/interval-60ms 的闸 → 末发不可能早于 ~3 个 interval(闸放不快过 interval)。
    // **只设下界(总时长)**:证明真定时器真的把请求摊开了 —— 负载只会让它更慢,顶不穿。
    // 不断言逐发间距 / 绝对延迟:那两条在负载下会被顶穿(gap 偶发为 0、首发被拖慢,实测过)。
    expect(Date.now() - t0).toBeGreaterThanOrEqual(INTERVAL * 2);
  });

  it("同 key 的两个 defineRateLimit 共享一个队(模块级状态活着)", async () => {
    const opts = { key: "wd2", limit: 1, interval: INTERVAL };
    const t0 = Date.now();
    await defineRateLimit(opts)(async () => {});
    await defineRateLimit(opts)(async () => {});
    expect(Date.now() - t0).toBeGreaterThan(INTERVAL * 0.6);
  });

  it("不同 key 不互相等", async () => {
    // 用注入的 sleep 记「被要求等多久」,不看墙上时钟 —— 绝对上界(<INTERVAL)在负载下会被顶穿
    // (实测 226 > 60)。两把 key 各自第一发都不该等;互不影响 = 两个 wait 都没被触发。
    let waitedA = -1;
    let waitedB = -1;
    await Promise.all([
      defineRateLimit({
        key: "a",
        limit: 1,
        interval: 5000,
        sleep: async (ms) => {
          waitedA = ms;
        },
      })(async () => {}),
      defineRateLimit({
        key: "b",
        limit: 1,
        interval: 5000,
        sleep: async (ms) => {
          waitedB = ms;
        },
      })(async () => {}),
    ]);
    expect(waitedA).toBe(-1); // 第一发有突发额度,不等
    expect(waitedB).toBe(-1); // 且 a 没让 b 等(不同 key 不共队)
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
