// @folio/shared —— 跟有限流的上游打交道的两件事:**按 key 限频的闸** + **认 Retry-After 的重试**。
//
// 用法:闸在模块顶层声明一次,每个请求进它的闭包。
//
//   const limit = defineRateLimit({ key: "COINGECKO_API_KEY", limit: 80, interval: 60_000 });
//   const rows = await limit(() => fetch(url).then((r) => r.json()));
//
// 上游的限额数字**不在这个包里** —— 那是各调用方 constants.ts 的事,因为限额是上游的属性。
//
// **目标是削峰,不是严格限频** —— 严格那档在 Workers 上只有 Durable Object 能做(#17),
// 而我们不需要:漏出去的那几发由 429 + withRetry 兜底。
//
// 存时隙的地方可配(`store`),**默认 Cache API** —— 同一个数据中心的 isolate 共享,于是
// 新 isolate 不会开局白给一整轮突发。缓存不可用时它自动兜底退回 `"memory"` —— 两者共用同一份
// 内存状态,cache 只是在外面加了跨 isolate 的读写。
//
// 都是手写的:限速要能把状态换成外部存储(p-throttle 把状态藏在闭包里,换不了),
// 重试要能「Retry-After 超上限就放弃」且能包非 HTTP 的领域调用(ky 只做夹紧版、只包 HTTP;
// p-retry 读不到 Retry-After)。两处都实测过库,都不够用。

// **对外只出这五个。** 其余(SlotStore / StoreChoice / RetryOpts / RetryInfo、以及两个 store 类)
// 只在包内用:它们出现在公开签名里,但调用方传的是对象字面量、靠结构类型对上,不需要能叫出名字。
// 少一个导出就少一处以后不敢动的地方。
export { bypassRateLimitsForTests, defineRateLimit, resetRateLimitsForTests } from "./ratelimit";
export { withRetry } from "./retry";
export type { RateLimiter } from "./types";
