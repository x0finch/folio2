import pThrottle from "p-throttle";
import type { Gate, RateLimitOptions } from "./types";

// 出站请求的速率闸。**限速这件事本身交给 p-throttle**,这里只负责两件它不管的事:
//   ① 按 key 把请求分到不同的队(它节流的是一个函数,不认识 key)
//   ② 让队列状态住在**模块级 Map** 上
//
// ②不是实现细节:额度是上游按 key / 按 IP 算的,不是按对象算的。一旦每个调用者各自持一个队,
// 6 路并发就等于 6 倍超速,闸等于没装。所以同 key 同队由这里保证,不靠调用点自律。
//
// 闸是 **isolate 级**的 —— 队列在这个模块的闭包里,跨 isolate 挡不住(要跨得上 Durable Object)。
// 单用户一轮同步就在一个 isolate 里,所以「同一把 key 被同一轮同步里的多个账户挤」这个最常见的
// 形状它拿得下。

type Queue = (run: () => Promise<unknown>) => Promise<unknown>;

const queues = new Map<string, Queue>();

// 仅测试用:清空所有队列(否则用例间顺序耦合)。生产代码勿调。
export function resetGatesForTests(): void {
  queues.clear();
}

// 仅测试用:让所有闸直接放行。
// **为什么需要它**:集成测试跑的是应用的真实接线,那条路上没有测试参数可传;而闸真等的话
// 那套测试会从 1 秒涨到几十秒。限速本身在本包的单测里用假时钟验,集成测试不该重复付这个成本。
let bypass = false;
export function bypassGatesForTests(on: boolean): void {
  bypass = on;
}

export function defineRateLimit(opts: RateLimitOptions): Gate {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new Error(`ratelimit: limit must be an integer >= 1 (${opts.key})`);
  }
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) {
    throw new Error(`ratelimit: interval must be a positive finite number (${opts.key})`);
  }

  return <T>(run: () => Promise<T>, subKey?: string): Promise<T> => {
    if (bypass) return run();
    const key = subKey === undefined ? opts.key : `${opts.key}:${subKey}`;
    let queue = queues.get(key);
    if (!queue) {
      // strict:真滑动窗口。默认的固定窗口能在边界一瞬间放两倍额度(窗口末尾 N 个 + 下个窗口
      // 开头 N 个)—— 而那正是要防的东西。
      queue = pThrottle({ limit: opts.limit, interval: opts.interval, strict: true })(
        (f: () => Promise<unknown>) => f(),
      );
      queues.set(key, queue);
    }
    return queue(run as () => Promise<unknown>) as Promise<T>;
  };
}
