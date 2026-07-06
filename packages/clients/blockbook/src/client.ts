import type { AddressResponse, XpubResponse } from "./types";

// @folio/blockbook-client —— SDK 式 Trezor Blockbook v2 只读客户端。零依赖,原生 fetch。
// xpub 走服务端派生(一次调用拿余额 + 逐地址),取代逐地址 gap 扫描。
// CF Workers:注入 User-Agent + 用全局 fetch(不存 this)。
// 多端点(btc2–btc5)轮询 + 失败回退:某端点限流/故障 → 自动换下一个,无需 env 配置。

export const BLOCKBOOK_BASES = [
  "https://btc2.trezor.io/api/v2",
  "https://btc3.trezor.io/api/v2",
  "https://btc4.trezor.io/api/v2",
  "https://btc5.trezor.io/api/v2",
];
export const USER_AGENT = "folio (+https://github.com/x0finch/folio2)";

export type BlockbookErrorCode = "RATE_LIMITED" | "AUTH_FAILED" | "UPSTREAM_ERROR" | "PARSE_ERROR";

export class BlockbookError extends Error {
  readonly code: BlockbookErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: BlockbookErrorCode,
    message: string,
    opts?: { retryable?: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BlockbookError";
    this.code = code;
    this.retryable = opts?.retryable ?? (code === "RATE_LIMITED" || code === "UPSTREAM_ERROR");
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : undefined;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function errorFor(res: Response): BlockbookError {
  if (res.status === 401 || res.status === 403) {
    return new BlockbookError("AUTH_FAILED", `blockbook auth failed (${res.status})`);
  }
  if (res.status === 429) {
    return new BlockbookError("RATE_LIMITED", "blockbook rate limited", {
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }
  if (res.status >= 500) {
    return new BlockbookError("UPSTREAM_ERROR", `blockbook upstream error (${res.status})`);
  }
  // 4xx(非 401/403/429):如无效 xpub → 不可重试,别浪费其它端点。
  return new BlockbookError("UPSTREAM_ERROR", `blockbook error (${res.status})`, {
    retryable: false,
  });
}

export interface BlockbookConfig {
  bases?: string[]; // 覆盖端点列表(测试/自托管);缺省用内置 btc2–btc5
  userAgent?: string;
}

export interface XpubQuery {
  details?: "basic" | "tokens" | "tokenBalances";
  tokens?: "nonzero" | "used" | "derived";
}

export interface BlockbookClient {
  /** xpub/descriptor 的余额 + 逐地址(服务端派生)。默认 tokenBalances + used。 */
  getXpub(token: string, query?: XpubQuery): Promise<XpubResponse>;
  /** 单地址余额。 */
  getAddress(address: string): Promise<AddressResponse>;
}

// 轮询起点(分散负载),模块级 round-robin。
let cursor = 0;

export function createBlockbookClient(config: BlockbookConfig = {}): BlockbookClient {
  const bases = config.bases && config.bases.length > 0 ? config.bases : BLOCKBOOK_BASES;
  const userAgent = config.userAgent ?? USER_AGENT;

  // 依次尝试端点:可重试错误(限流/5xx/网络)→ 换下一个;不可重试(如 4xx 无效 xpub)→ 立抛。
  async function request<T>(path: string): Promise<T> {
    const start = cursor++ % bases.length;
    let lastErr: BlockbookError | undefined;
    for (let i = 0; i < bases.length; i++) {
      const base = bases[(start + i) % bases.length];
      let res: Response;
      try {
        res = await fetch(`${base}${path}`, {
          headers: { "user-agent": userAgent, accept: "application/json" },
        });
      } catch (cause) {
        lastErr = new BlockbookError("UPSTREAM_ERROR", "blockbook request failed", { cause });
        continue; // 网络故障 → 试下一个端点
      }
      if (!res.ok) {
        const err = errorFor(res);
        if (!err.retryable) throw err;
        lastErr = err;
        continue;
      }
      try {
        return (await res.json()) as T;
      } catch (cause) {
        throw new BlockbookError("PARSE_ERROR", "blockbook returned invalid JSON", { cause });
      }
    }
    throw lastErr ?? new BlockbookError("UPSTREAM_ERROR", "all blockbook endpoints failed");
  }

  // encodeURIComponent 不编码括号,但 descriptor(如 tr(xpub…))的括号在 path 里更稳妥地编码掉。
  const encodePath = (s: string): string =>
    encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29");

  return {
    getXpub(token, query) {
      const details = query?.details ?? "tokenBalances";
      const tokens = query?.tokens ?? "used";
      return request<XpubResponse>(
        `/xpub/${encodePath(token)}?details=${details}&tokens=${tokens}`,
      );
    },
    getAddress(address) {
      return request<AddressResponse>(`/address/${encodePath(address)}`);
    },
  };
}
