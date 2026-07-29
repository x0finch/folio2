// @folio/ratelimit —— 跟有限流的上游打交道的两件事:**主动限速的闸** + **被动兜底的重试**。
//
// 用法:策略在模块顶层声明一次,`acquire()` 就地调。
//
//   const limit = defineLimit({ key: "rabby", capacity: 1, ratePerSec: 8 });
//   await limit.acquire();
//
// 数字不放这个包里 —— 各调用方自己的 constants.ts 说了算(原则 #8),因为限额是上游的属性。

import { acquireFromBucket, fullKeyOf, resetBucketsForTests } from "./bucket";
import type { Limit, LimitPolicy } from "./types";

export { withRetry } from "./retry";
export type { Limit, LimitLogger, LimitPolicy, LimitScope, RetryInfo, RetryOpts } from "./types";

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 仅测试用:清空所有桶。生产代码勿调。
export function resetLimitsForTests(): void {
  resetBucketsForTests();
}

export function defineLimit(policy: LimitPolicy): Limit {
  const clock = policy.clock ?? Date.now;
  const sleep = policy.sleep ?? defaultSleep;

  return {
    async acquire(subKey) {
      const { waitMs } = acquireFromBucket(policy, clock, fullKeyOf(policy.key, subKey));
      if (waitMs > 0) await sleep(waitMs);
    },
  };
}
