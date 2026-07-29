// @folio/ratelimit —— 跟有限流的上游打交道的两件事:**主动限速的闸** + **被动兜底的重试**。
//
// 用法:策略在模块顶层声明一次,`acquire()` 就地调。
//
//   const limit = defineLimit({ key: "rabby", capacity: 1, ratePerSec: 8 });
//   await limit.acquire();
//
// 数字不放这个包里 —— 各调用方自己的 constants.ts 说了算(原则 #8),因为限额是上游的属性。

import { acquireFromBucket, fullKeyOf, resetBucketsForTests } from "./bucket";
import { readCooldown, resetCooldownForTests, writeCooldown } from "./cooldown";
import type { Limit, LimitPolicy } from "./types";

export { RateLimitedError } from "./errors";
export { withRetry } from "./retry";
export type {
  CooldownStore,
  Limit,
  LimitLogger,
  LimitPolicy,
  LimitScope,
  RetryInfo,
  RetryOpts,
} from "./types";

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let defaultSleep = realSleep;

// 仅测试用:清空所有桶与冷却标记。生产代码勿调。
export function resetLimitsForTests(): void {
  resetBucketsForTests();
  resetCooldownForTests();
}

// 仅测试用:把「等待」整体换成即时(不传 = 还原成真 setTimeout)。
//
// **为什么要一个全局开关,而不是各处传 sleep**:集成测试跑的是**应用的真实接线**
// (apps/web 的 cgConfig → createCoinGeckoClient),那条路上没有、也不该有测试参数。
// 不换掉的话闸会让那套测试真等 —— 无 key 档一发就是 6 秒。
export function setSleepForTests(sleep?: (ms: number) => Promise<void>): void {
  defaultSleep = sleep ?? realSleep;
}

export function defineLimit(policy: LimitPolicy): Limit {
  // 立刻拒掉说不通的策略。**这不是防御性编程,是防一个静默故障**:`ratePerSec: 0` 会让间隔算成
  // Infinity、突发额度算成 NaN,于是每次 acquire 的等待都是 NaN —— `NaN > 0` 为假,闸一次都不拦,
  // 悄悄退化成没装。一个常量打错字就没了限速而且零信号,所以宁可在模块加载期就炸。
  if (!Number.isFinite(policy.ratePerSec) || policy.ratePerSec <= 0) {
    throw new Error(`ratelimit: ratePerSec must be a positive finite number (${policy.key})`);
  }
  if (!Number.isInteger(policy.capacity) || policy.capacity < 1) {
    throw new Error(`ratelimit: capacity must be an integer >= 1 (${policy.key})`);
  }
  const clock = policy.clock ?? Date.now;
  const sleep = policy.sleep ?? ((ms: number) => defaultSleep(ms));
  // global 档(Durable Object 真配额)还没实现 —— 降级成 colo 并说一声,而不是假装限住了。
  // 它只在「按 key 计费的上游 + 多用户同时同步」时才需要,自托管单用户碰不到(见 #17 M10.4)。
  const effective: LimitPolicy =
    policy.scope === "global" ? { ...policy, scope: "colo", log: policy.log } : policy;
  if (policy.scope === "global") {
    policy.log?.("ratelimit: scope 'global' is not implemented yet, falling back to 'colo'", {
      key: policy.key,
    });
  }

  return {
    async acquire(subKey) {
      const fullKey = fullKeyOf(policy.key, subKey);
      // 冷却优先于桶:正在冷却就压根不该发,过完闸再拒是白等。
      await readCooldown(effective, clock, fullKey);
      const { waitMs } = acquireFromBucket(effective, clock, fullKey);
      if (waitMs > 0) await sleep(waitMs);
    },

    async cooldown(ms, subKey) {
      await writeCooldown(effective, clock, fullKeyOf(policy.key, subKey), ms);
    },
  };
}
