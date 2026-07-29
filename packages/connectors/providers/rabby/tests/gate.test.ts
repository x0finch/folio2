import { beforeEach, describe, expect, it } from "vitest";
import { MAX_REQUESTS_PER_SECOND } from "../src/constants";
import { rateGate, resetGateForTests } from "../src/gate";

// 假时钟:sleep 不真等,只把时间推进 —— 于是能确定性地断言速率,测试不花一秒钟。
function fakeClock() {
  let now = 0;
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

describe("rateGate", () => {
  beforeEach(() => resetGateForTests());

  it("串行放行时把请求摊成 MAX_REQUESTS_PER_SECOND 次/秒", async () => {
    const t = fakeClock();
    const times: number[] = [];
    for (let i = 0; i < MAX_REQUESTS_PER_SECOND * 2; i++) {
      await rateGate(t.clock, t.sleep);
      times.push(t.at());
    }
    // 第一发不等;之后每发间隔 1000/8 = 125ms
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(1000 / MAX_REQUESTS_PER_SECOND, 6);
    }
    // 任意 1 秒窗口内不超过 MAX_REQUESTS_PER_SECOND 发
    expect(times.filter((x) => x < 1000)).toHaveLength(MAX_REQUESTS_PER_SECOND);
  });

  it("并发放行也不挤在一起 —— 抢时隙是同步的", async () => {
    // 这里**不能**用会推进时间的 sleep:12 个并发共享一个假时钟,谁 sleep 都会推进它,
    // 读回来的时间就分不出彼此了。直接看「各自被要求等多久」——这正是时隙分配的结果。
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    // 并发 12(= sync 的 6 个账户 × 2 发,实测正压在 rabby 的坎上)
    await Promise.all(Array.from({ length: 12 }, () => rateGate(() => 0, sleep)));
    // 第一发不等(wait=0 不进 sleep),其余 11 发依次错开 125ms —— 没有两个撞在一起
    expect(waits).toHaveLength(11);
    expect(waits).toEqual(
      Array.from({ length: 11 }, (_, i) => ((i + 1) * 1000) / MAX_REQUESTS_PER_SECOND),
    );
  });

  it("闲置之后不惩罚 —— 时间早过了就立刻放行", async () => {
    const t = fakeClock();
    await rateGate(t.clock, t.sleep);
    t.advance(60_000);
    const before = t.at();
    await rateGate(t.clock, t.sleep);
    expect(t.at()).toBe(before); // 没有等待
  });
});
