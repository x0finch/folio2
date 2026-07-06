import { ProviderError, parseRetryAfter } from "@folio/balances-basic";
import { USER_AGENT } from "./constants";

// Esplora HTTP 客户端。CF Workers:显式带 User-Agent + 用全局 fetch(见 CLAUDE.md 坑:
// 缺 UA 出站 HTTP 可能静默 403/抛)。网络故障 → UPSTREAM_ERROR(可重试);状态码交 ensureOk。
export async function esploraGet(base: string, path: string): Promise<Response> {
  try {
    return await fetch(`${base}${path}`, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
  } catch (cause) {
    throw new ProviderError("UPSTREAM_ERROR", "esplora request failed", { cause });
  }
}

// 非 2xx → 按语义抛 ProviderError。429 可重试(读 Retry-After);401/403 认证失败(自托管节点带鉴权时);
// 其余当上游临时故障(可重试)。
export function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError("AUTH_FAILED", `esplora auth failed (${res.status})`);
  }
  if (res.status === 429) {
    throw new ProviderError("RATE_LIMITED", "esplora rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw new ProviderError("UPSTREAM_ERROR", `esplora upstream error (${res.status})`);
}
