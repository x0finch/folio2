// 编排参数(原则 #8:不硬编码散落)。改这里就是改行为 —— 每个数背后的账写在注释里。
export const RETRY_MAX_ATTEMPTS = 3; // 总尝试次数(1 + 2 重试)
export const RETRY_BASE_MS = 200; // 指数退避基数,也是抖动幅度上限
export const RETRY_MAX_MS = 5000; // 单次退避上限(Retry-After 超过它就夹到这)
export const SYNC_CONCURRENCY = 6; // 每用户账户取数的并发上限(CF subrequest / provider 限流留余量)
export const FETCH_TIMEOUT_MS = 20_000; // 单次取数(单次尝试)超时上限
