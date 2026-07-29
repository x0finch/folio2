import { beforeEach, describe, expect, it } from "vitest";
import { defineLimit, resetLimitsForTests } from "../src/index";

// 假时钟:sleep 不真等,只把时间推进 —— 于是能确定性地断言速率,测试不花一秒钟。
function fakeClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

beforeEach(() => resetLimitsForTests());

describe("容量 1 —— 与迁移前 rabby 的闸完全同构", () => {
  it("把请求摊成 ratePerSec 次/秒", async () => {
    const t = fakeClock();
    const limit = defineLimit({ key: "k", capacity: 1, ratePerSec: 8, ...t });
    const times: number[] = [];
    for (let i = 0; i < 16; i++) {
      await limit.acquire();
      times.push(t.at());
    }
    // 第一发不等;之后每发间隔 1000/8 = 125ms
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(125, 6);
    }
    // 任意 1 秒窗口内不超过 8 发
    expect(times.filter((x) => x < 1000)).toHaveLength(8);
  });

  it("并发放行也不挤在一起 —— 抢时隙是同步的", async () => {
    // 这里**不能**用会推进时间的 sleep:12 个并发共享一个假时钟,谁 sleep 都会推进它,
    // 读回来的时间就分不出彼此了。直接看「各自被要求等多久」——这正是时隙分配的结果。
    const waits: number[] = [];
    const limit = defineLimit({
      key: "k",
      capacity: 1,
      ratePerSec: 8,
      clock: () => 0,
      sleep: async (ms) => void waits.push(ms),
    });
    await Promise.all(Array.from({ length: 12 }, () => limit.acquire()));
    // 第一发不等(wait=0 不进 sleep),其余 11 发依次错开 125ms —— 没有两个撞在一起
    expect(waits).toEqual(Array.from({ length: 11 }, (_, i) => (i + 1) * 125));
  });

  it("闲置之后不惩罚 —— 时间早过了就立刻放行", async () => {
    const t = fakeClock();
    const limit = defineLimit({ key: "k", capacity: 1, ratePerSec: 8, ...t });
    await limit.acquire();
    t.advance(60_000);
    const before = t.at();
    await limit.acquire();
    expect(t.at()).toBe(before); // 没有等待
  });
});

describe("容量 > 1 —— 允许突发,用完后按补充速率放行", () => {
  it("头 capacity 发立刻走,第 capacity+1 发才开始等", async () => {
    const waits: number[] = [];
    const limit = defineLimit({
      key: "k",
      capacity: 5,
      ratePerSec: 8,
      clock: () => 0,
      sleep: async (ms) => void waits.push(ms),
    });
    for (let i = 0; i < 8; i++) await limit.acquire();
    // 前 5 发 wait=0(不进 sleep),第 6/7/8 发依次 125 / 250 / 375
    expect(waits).toEqual([125, 250, 375]);
  });

  it("突发额度按 ratePerSec 回补 —— 等够一个间隔就又能借一发", async () => {
    const t = fakeClock();
    const limit = defineLimit({ key: "k", capacity: 3, ratePerSec: 8, ...t });
    for (let i = 0; i < 3; i++) await limit.acquire(); // 抽干
    expect(t.at()).toBe(0);
    t.advance(125); // 回补一发
    const before = t.at();
    await limit.acquire();
    expect(t.at()).toBe(before); // 立刻放行
    await limit.acquire();
    expect(t.at()).toBeGreaterThan(before); // 再一发就得等
  });
});

describe("桶按 key 共享 —— 这是限速真正生效的前提", () => {
  it("两个 defineLimit 同 key → 同一个桶(否则并发调用者各自满速,等于没限)", async () => {
    const waits: number[] = [];
    const opts = {
      capacity: 1,
      ratePerSec: 8,
      clock: () => 0,
      sleep: async (ms: number) => void waits.push(ms),
    };
    const a = defineLimit({ key: "same", ...opts });
    const b = defineLimit({ key: "same", ...opts });
    await a.acquire();
    await b.acquire();
    expect(waits).toEqual([125]); // b 排在 a 后面
  });

  it("不同 key 互不影响", async () => {
    const waits: number[] = [];
    const opts = {
      capacity: 1,
      ratePerSec: 8,
      clock: () => 0,
      sleep: async (ms: number) => void waits.push(ms),
    };
    await defineLimit({ key: "a", ...opts }).acquire();
    await defineLimit({ key: "b", ...opts }).acquire();
    expect(waits).toEqual([]); // 各自的第一发
  });

  it("subKey 拼在 key 后面 —— 每账户独立额度用它区分", async () => {
    const waits: number[] = [];
    const limit = defineLimit({
      key: "cex",
      capacity: 1,
      ratePerSec: 8,
      clock: () => 0,
      sleep: async (ms) => void waits.push(ms),
    });
    await limit.acquire("acct-1");
    await limit.acquire("acct-2"); // 不同 subKey → 不同桶 → 不等
    expect(waits).toEqual([]);
    await limit.acquire("acct-1"); // 同 subKey → 排队
    expect(waits).toEqual([125]);
  });
});
