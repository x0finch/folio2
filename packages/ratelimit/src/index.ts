// @folio/ratelimit —— 跟有限流的上游打交道的两件事:**按 key 限频的闸** + **认 Retry-After 的重试**。
//
// 用法:闸在模块顶层声明一次,每个请求进它的闭包。
//
//   const gate = defineRateLimit({ key: "COINGECKO_API_KEY", limit: 80, interval: 60_000 });
//   const rows = await gate(() => fetch(url).then((r) => r.json()));
//
// 上游的限额数字**不在这个包里** —— 那是各调用方 constants.ts 的事,因为限额是上游的属性。
//
// 限速本身用 p-throttle(零依赖、维护中、workerd 实测可用);本包只加它不管的两件事:
// 按 key 分队,和把队列钉在模块级(见 gate.ts:那条是正确性问题,不是实现细节)。
// 重试仍是手写的 —— 没有库能在「Retry-After 超上限就放弃」和「包住非 HTTP 的领域调用」这两点
// 上同时够用(ky 只做前者的夹紧版、且只包 HTTP;p-retry 读不到 Retry-After)。

export { bypassGatesForTests, defineRateLimit, resetGatesForTests } from "./gate";
export { withRetry } from "./retry";
export type { Gate, RateLimitOptions, RetryInfo, RetryOpts } from "./types";
