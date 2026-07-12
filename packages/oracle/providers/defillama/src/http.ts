import { TokenError } from "@folio/oracle-basic";
import { DL_BASE, USER_AGENT } from "./constants";

// 低层 GET(内部):拼 URL + UA 头 + 错误映射,直接抛 token 域 TokenError
//(DefiLlama 简单/keyless,无需中间 client 错误类)。429 → RATE_LIMITED(+retryAfterMs),
// 5xx/网络 → UPSTREAM_ERROR(retryable),其余非 2xx → UPSTREAM_ERROR(non-retryable),坏 JSON → PARSE_ERROR。
// 直接用全局 `fetch`(不存 this,避免 Workers illegal invocation)。

// Retry-After 头:纯秒数 或 HTTP-date → ms;缺失/无法解析 → undefined(镜像 coingecko-client)。
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export interface DefiLlamaConfig {
  baseUrl?: string; // 覆盖基址(测试/自托管代理)
}

export type Requester = (path: string) => Promise<unknown>;

export function createRequester(config: DefiLlamaConfig = {}): Requester {
  const baseUrl = config.baseUrl ?? DL_BASE;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };

  return async (path) => {
    const url = new URL(`${baseUrl}${path}`);

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (cause) {
      throw new TokenError("UPSTREAM_ERROR", `defillama network error: ${path}`, {
        retryable: true,
        cause,
      });
    }

    if (!res.ok) {
      if (res.status === 429) {
        throw new TokenError("RATE_LIMITED", `defillama rate limited: ${path}`, {
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        });
      }
      throw new TokenError("UPSTREAM_ERROR", `defillama ${res.status} on ${path}`, {
        retryable: res.status >= 500,
      });
    }

    try {
      return await res.json();
    } catch (cause) {
      throw new TokenError("PARSE_ERROR", `defillama bad json: ${path}`, { cause });
    }
  };
}
