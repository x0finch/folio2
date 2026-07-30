import { withRetry } from "./retry";
import type { Fetcher, FetchOptions, HttpClientOptions } from "./types";

// 一个薄的 fetch 包装:**限频 → 出网 → 归类失败 → 重试**,四步的顺序和归类规则收在一处。
//
// 为什么值得共享:五个 provider 各写了一份几乎一样的 `ensureOk`(四份连字都只差 provider 名,
// binance 多认一个 418),`parseRetryAfter` 在仓库里有三份。重复的不是「怎么发请求」,
// 是「非 2xx 怎么读」。
//
// **它不认识任何错误类型。** 每家抛自己的(provider 抛 ProviderError、client 抛自己的),
// 所以归类结果交给调用方的 `toFailure` 变成具体错误 —— 包不去猜谁该用哪个类。
//
// 关于重试:`toFailure` 造出来的错误得带 `retryable` / `retryAfterMs`(仓库里那四个错误类都带),
// 否则 `withRetry` 认不出可重试。也可以在 `retry.isRetryable` 里自己判。
//
// 闸放在**重试里面** —— 重试也该排队,否则退避完立刻插队。

// Retry-After:纯秒数 或 HTTP-date → 毫秒;缺失/无效 → undefined。
// **不导出** —— 调用方拿到的是 `Failure.retryAfterMs`,不需要自己解析头(仓库里现有那三份
// 重复实现正是因为每家都自己解一遍)。
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : undefined;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

const DEFAULT_RATE_LIMITED = [429];

export function createHttpClient(opts: HttpClientOptions): Fetcher {
  const rateLimited = new Set(opts.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED);

  const once = async (path: string, options: FetchOptions | undefined): Promise<unknown> => {
    const url = new URL(`${opts.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // **失败信息里只带 pathname,不带 query。** query 里有地址、签名这类东西,而这个对象会进
    // 错误消息和日志(原则 #5 的红线)。
    const where = url.pathname;

    let res: Response;
    try {
      const headers = opts.headers ? await opts.headers(path, options) : undefined;
      res = await fetch(url, { ...options?.init, headers });
    } catch (cause) {
      throw opts.toFailure({ kind: "network", where, cause });
    }

    if (!res.ok) {
      if (rateLimited.has(res.status)) {
        throw opts.toFailure({
          kind: "rate-limited",
          where,
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), Date.now()),
        });
      }
      if (res.status === 401 || res.status === 403) {
        throw opts.toFailure({ kind: "auth", where, status: res.status });
      }
      // 「这个东西不存在」对某些端点是正常答案,不是故障(比如按合约查币)。
      if (res.status === 404 && options?.notFoundAsNull) return null;
      throw opts.toFailure({ kind: "upstream", where, status: res.status });
    }

    try {
      return await res.json();
    } catch (cause) {
      throw opts.toFailure({ kind: "parse", where, cause });
    }
  };

  return (path, options) => {
    const send = () => (opts.limit ? opts.limit(() => once(path, options)) : once(path, options));
    return opts.retry ? withRetry(send, opts.retry) : send();
  };
}
