import { MAX_REQUESTS_PER_SECOND } from "./constants";

// 出站请求的速率闸。**为什么需要它**:rabby 掐的不是总量而是瞬时并发 —— 实测(签名请求、同一 IP)
// 串行 150 发零 429,但 20 并发掉 5 发、第二轮 14 并发掉 12 发,而且被压过之后恢复得慢。
//
// 而 @folio/sync 的 SYNC_CONCURRENCY 是 6,每个账户还要发 2~3 个请求 → 真实瞬时并发 ~12,正压在坎上。
//
// **策略是「从不撞」,不是「撞了再重试」**:sync 的退避上限 RETRY_MAX_MS 只有 5s,而 rabby 恢复更慢,
// 撞上了三次重试很可能全白打。
//
// 实现是「下一个可用时隙」而非令牌桶:不允许突发,请求被均匀摊成 8 次/秒。代价是同一账户的第二发
// 多等 125ms —— 换限速永不触发,值。闸是 **isolate 级**的(和链清单缓存同一档),跨 isolate 挡不住;
// 单用户单轮同步就在一个 isolate 里,够用。

const MIN_INTERVAL_MS = 1000 / MAX_REQUESTS_PER_SECOND;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let nextSlotAt = 0;

// 仅测试用:重置闸(否则用例间顺序耦合)。生产代码勿调。
export function resetGateForTests(): void {
  nextSlotAt = 0;
}

// 排到自己的时隙再放行。clock/sleep 可注入 —— 测试要断言「1 秒内不超过 8 发」就得能控时间。
export async function rateGate(
  clock: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const now = clock();
  // 抢时隙这一步是同步的 → 并发调用各自拿到不同的时隙,不会挤在一起。
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}
