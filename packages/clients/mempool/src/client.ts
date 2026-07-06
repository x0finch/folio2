import type { AddressResponse } from "./types";

// @folio/mempool-client —— SDK 式 Esplora(mempool.space)只读客户端。零依赖,原生 fetch。
// CF Workers 修复:① 注入 User-Agent(缺 UA 可能被 WAF 静默 403);② 直接用全局 `fetch`(不存 this,避免 illegal invocation)。

export const MEMPOOL_BASE_DEFAULT = "https://mempool.space/api"; // 不含尾斜杠
export const USER_AGENT = "folio (+https://github.com/x0finch/folio2)";

export type MempoolErrorCode = "RATE_LIMITED" | "AUTH_FAILED" | "UPSTREAM_ERROR" | "PARSE_ERROR";

export class MempoolError extends Error {
  readonly code: MempoolErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: MempoolErrorCode,
    message: string,
    opts?: { retryable?: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "MempoolError";
    this.code = code;
    this.retryable = opts?.retryable ?? (code === "RATE_LIMITED" || code === "UPSTREAM_ERROR");
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

// Retry-After 头:纯秒数 或 HTTP-date → ms;缺失/无法解析 → undefined。
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : undefined;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function ensureOk(res: Response): void {
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new MempoolError("AUTH_FAILED", `mempool auth failed (${res.status})`);
  }
  if (res.status === 429) {
    throw new MempoolError("RATE_LIMITED", "mempool rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  throw new MempoolError("UPSTREAM_ERROR", `mempool upstream error (${res.status})`);
}

export interface MempoolConfig {
  baseUrl?: string; // 覆盖基址(自托管 Esplora 节点);空/缺 → 公共 mempool.space
  userAgent?: string;
}

export interface MempoolClient {
  /** 取地址的已确认 + 未确认统计。网络/状态码/坏 JSON → MempoolError。 */
  getAddress(address: string): Promise<AddressResponse>;
}

export function createMempoolClient(config: MempoolConfig = {}): MempoolClient {
  const baseUrl = config.baseUrl?.trim() || MEMPOOL_BASE_DEFAULT;
  const userAgent = config.userAgent ?? USER_AGENT;
  return {
    async getAddress(address) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/address/${address}`, {
          headers: { "user-agent": userAgent, accept: "application/json" },
        });
      } catch (cause) {
        throw new MempoolError("UPSTREAM_ERROR", "mempool request failed", { cause });
      }
      ensureOk(res);
      try {
        return (await res.json()) as AddressResponse;
      } catch (cause) {
        throw new MempoolError("PARSE_ERROR", "mempool returned invalid JSON", { cause });
      }
    },
  };
}
