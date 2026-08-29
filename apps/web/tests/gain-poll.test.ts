import { describe, expect, it } from "vitest";
import { POLL_INTERVAL, precomputePollDelay } from "@/lib/queries/constants";

// 24h 盈亏读到 `pending` 时的轮询节奏(ADR 0049)。
//
// **这条不是在测一个公式,是在测两个上限存不存在。** 没有它们的话这是台永动机:补算失败
// (数据本身让计算抛)时键永远填不上 → 响应恒 `pending` → 前端每秒一发,而**每一发都在服务端
// 排一趟全量重算**。一个用户开着页面就能把一个 isolate 占满,而屏幕上什么都不会发生。
// 所以这里断言的是「会变慢」和「会停」,不是某一档具体多少毫秒。

describe("precomputePollDelay", () => {
  it("第一发就是 POLL_INTERVAL.precompute —— 正常情况下补算几百毫秒就落地,一发即中", () => {
    expect(precomputePollDelay(0)).toBe(POLL_INTERVAL.precompute);
  });

  it("越问越慢(退避),而且封顶", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => precomputePollDelay(n));
    for (let i = 1; i < delays.length; i++) {
      expect(Number(delays[i])).toBeGreaterThanOrEqual(Number(delays[i - 1]));
    }
    for (const d of delays) expect(Number(d)).toBeLessThanOrEqual(15_000);
  });

  it("问够了就**放弃**,不是无限地慢慢问", () => {
    expect(precomputePollDelay(8)).toBe(false);
    expect(precomputePollDelay(50)).toBe(false);
  });

  it("退避总时长是分钟量级 —— 够跨过一次抖动,不至于一直挂着", () => {
    let total = 0;
    for (let n = 0; ; n++) {
      const d = precomputePollDelay(n);
      if (d === false) break;
      total += d;
    }
    expect(total).toBeGreaterThan(30_000);
    expect(total).toBeLessThan(5 * 60_000);
  });
});
