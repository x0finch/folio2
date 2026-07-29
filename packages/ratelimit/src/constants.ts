// @folio/ratelimit 自己的常量(原则 #8)。上游的限额**不在这里** —— 那是各调用方
// constants.ts 的事,因为限额是上游的属性,不是本包的。

// 冷却标记在 Cache API 里的命名空间与 key 前缀。用一个内部假域名:Cache API 只拿它当 key,
// 不会真去请求。
export const COOLDOWN_CACHE_NAME = "folio-ratelimit";
export const COOLDOWN_URL_PREFIX = "https://ratelimit.folio.internal/cooldown/";

// 冷却时长上限。**为什么要夹**:冷却期间这份额度上的每次调用都立刻失败(SWR 于是给旧数据),
// 上游其实已经恢复的那段窗口就白等了。60s 覆盖已知上游给过的最长 Retry-After(CGK 免费档),
// 再长就说明是配额耗尽而不是瞬时抖动 —— 那种情况冷却也救不了,该让 SWR 顶着。
export const COOLDOWN_MAX_MS = 60_000;

// 上游 429 不带 Retry-After 时的保守冷却(rabby 实测就不带)。一次瞬时抖动的量级。
export const COOLDOWN_DEFAULT_MS = 5_000;
