import { describe, expect, it } from "vitest";
import { POLL_INTERVAL, pendingPollDelay, precomputePollDelay } from "@/lib/queries/constants";

// 读到 `pending` 时的轮询节奏(ADR 0049)—— 总览、tab 条、两级 24h 盈亏共用这一套。
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

// **这一组是一个真 bug 的钉子。** 上一版数「问了几次」用的是 `query.state.dataUpdateCount - 1`,
// 而那是这条查询**一辈子**的成功计数:窗口重新聚焦 +1、每次同步失效重拉 +1、切组合回来 +1。
// 页面开着不动,九次成功之后它就自己越过上限 —— 轮询从此永久关闭,而症状发生在**将来**某次
// 同步之后:读到旧值 + `pending`,再也没有第二次刷新。测试写成「按次数」是看不出来的,
// 必须先把那个一辈子计数堆高,再开始这一轮。
describe("pendingPollDelay", () => {
  const q = (pending: boolean, dataUpdateCount: number) => ({
    state: { data: pending ? { pending: true as const } : {}, dataUpdateCount },
  });

  it("页面已经成功取过很多次 → 新的一轮 pending 照常从第一档开始", () => {
    // 12 次成功更新(聚焦、失效、切组合……),然后才第一次读到 pending。
    const query = q(true, 12);
    expect(pendingPollDelay(query)).toBe(POLL_INTERVAL.precompute);
  });

  it("同一轮里越问越慢", () => {
    const query = q(true, 12);
    expect(pendingPollDelay(query)).toBe(POLL_INTERVAL.precompute);
    query.state.dataUpdateCount = 13;
    expect(pendingPollDelay(query)).toBe(2 * POLL_INTERVAL.precompute);
    query.state.dataUpdateCount = 14;
    expect(pendingPollDelay(query)).toBe(4 * POLL_INTERVAL.precompute);
  });

  it("同一轮问够了就放弃", () => {
    const query = q(true, 100);
    for (let n = 0; n < 8; n++) {
      expect(pendingPollDelay(query)).not.toBe(false);
      query.state.dataUpdateCount++;
    }
    expect(pendingPollDelay(query)).toBe(false);
  });

  it("`pending` 消失 → 停;下次再 pending 是**新的一轮**,从头数", () => {
    const query = q(true, 3);
    for (let n = 0; n < 8; n++) {
      pendingPollDelay(query);
      query.state.dataUpdateCount++;
    }
    expect(pendingPollDelay(query)).toBe(false); // 这一轮认输了

    // 算好了:pending 消失,轮询关掉。
    const settled = { state: { data: {}, dataUpdateCount: query.state.dataUpdateCount } };
    Object.assign(query.state, settled.state);
    expect(pendingPollDelay(query)).toBe(false);

    // 又一次同步让它变旧 —— 这一轮必须重新开始问,而不是继承上一轮的「已经认输」。
    Object.assign(query.state, { data: { pending: true as const }, dataUpdateCount: 30 });
    expect(pendingPollDelay(query)).toBe(POLL_INTERVAL.precompute);
  });
});
