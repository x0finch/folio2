import type { LimitPolicy } from "./types";

// 令牌桶(GCRA 形式)。**为什么是「容量 + 补充速率」而不是「最小间隔」**:上游的限流形状不一样 ——
// rabby 掐的是瞬时并发(实测串行 150 发零 429,20 并发掉 5 发),CoinGecko 掐的是分钟窗口配额。
// 桶能同时表达两种:容量 = 允许多大的突发,速率 = 突发用完后多快回补。容量 1 就退化成
// 「均匀摊开、不许突发」,也就是迁移前 rabby 那个「下一个可用时隙」。
//
// 实现只存一个数 `tat`(theoretical arrival time,下一发的理论到达时刻):
//   · 放行时刻 = tat - 突发额度,早于 now 就是不用等
//   · 每放行一发,tat 往后推一个间隔
//   · tat 先 max(tat, now) —— 闲置过后 tat 落在过去,于是突发额度自动补满(不惩罚闲置)
//
// **状态挂在模块级 Map 上,按 key 索引**,不挂在 defineLimit 返回的对象上。这不是实现细节:
// 限流额度是按 key / 按 IP 算的,不是按对象算的 —— 一旦每个调用者各自持一个桶,6 路并发
// 就等于 6 倍超速,闸等于没装。同 key 同桶由这里保证,不靠调用点自律。
//
// 闸是 **isolate 级**的:跨 isolate 挡不住(要跨得上 Durable Object,见 #17)。单用户一轮同步
// 就在一个 isolate 里,所以「同一把 key 被同一轮同步里的多个账户挤」这个最常见的形状它拿得下。

interface BucketState {
  tat: number; // 下一发的理论到达时刻(epoch ms)
}

const buckets = new Map<string, BucketState>();

// 仅测试用:清空所有桶(否则用例间顺序耦合)。生产代码勿调。
export function resetBucketsForTests(): void {
  buckets.clear();
}

export function fullKeyOf(key: string, subKey?: string): string {
  return subKey === undefined ? key : `${key}:${subKey}`;
}

// 排到自己的时隙再放行。返回实际等了多久(测试和日志用)。
export function acquireFromBucket(
  policy: LimitPolicy,
  clock: () => number,
  fullKey: string,
): { waitMs: number; nextTat: number } {
  const intervalMs = 1000 / policy.ratePerSec;
  const burstMs = (policy.capacity - 1) * intervalMs; // tat 允许领先 now 多远
  const now = clock();

  let state = buckets.get(fullKey);
  if (!state) {
    state = { tat: now };
    buckets.set(fullKey, state);
  }

  // 抢时隙这一步**必须同步**(算完就写回)→ 并发调用各自拿到不同的时隙,不会挤在一起。
  const tat = Math.max(state.tat, now);
  const releaseAt = tat - burstMs;
  state.tat = tat + intervalMs;

  return { waitMs: Math.max(0, releaseAt - now), nextTat: state.tat };
}
