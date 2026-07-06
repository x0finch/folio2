// 低层 HTTP(内部)——拼 URL/头 + 错误映射,不对外导出 request;SDK 方法建于其上(见 client.ts)。
// 含两处 CF Workers 修复:
//   ① 注入 User-Agent —— CGK 的 Cloudflare WAF 对无 UA 请求返 403(Workers fetch 默认不带 UA)。
//   ② 直接用全局 `fetch`(不存成方法/this,避免 Workers 的 illegal invocation)。

export const CG_BASE_FREE = "https://api.coingecko.com/api/v3";
export const CG_BASE_PRO = "https://pro-api.coingecko.com/api/v3";
export const HEADER_DEMO = "x-cg-demo-api-key";
export const HEADER_PRO = "x-cg-pro-api-key";
export const USER_AGENT = "folio-portfolio-tracker/1.0 (+https://github.com/x0finch/folio)";

export type CoinGeckoErrorCode = "RATE_LIMITED" | "UPSTREAM_ERROR" | "PARSE_ERROR";

export class CoinGeckoError extends Error {
  readonly code: CoinGeckoErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: CoinGeckoErrorCode,
    message: string,
    opts?: { retryable?: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CoinGeckoError";
    this.code = code;
    this.retryable = opts?.retryable ?? code === "RATE_LIMITED";
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

// Retry-After 头:纯秒数 或 HTTP-date → ms;缺失/无法解析 → undefined。
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export interface CoinGeckoConfig {
  apiKey?: string;
  pro?: boolean; // pro key → pro 基址 + pro 头;否则 demo 头 + free 基址
  baseUrl?: string; // 覆盖基址(测试/自托管代理)
}

export type Query = Record<string, string | number | undefined>;
export interface RequestOptions {
  notFoundAsNull?: boolean;
}

// 内部低层 GET:404 且 notFoundAsNull → null,其余非 2xx / 网络 / 坏 JSON 抛 CoinGeckoError。
export type Requester = (path: string, query?: Query, opts?: RequestOptions) => Promise<unknown>;

export function createRequester(config: CoinGeckoConfig = {}): Requester {
  const baseUrl = config.baseUrl ?? (config.pro ? CG_BASE_PRO : CG_BASE_FREE);
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  if (config.apiKey) headers[config.pro ? HEADER_PRO : HEADER_DEMO] = config.apiKey;

  return async (path, query, opts) => {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (cause) {
      throw new CoinGeckoError("UPSTREAM_ERROR", `coingecko network error: ${path}`, {
        retryable: true,
        cause,
      });
    }

    if (!res.ok) {
      if (res.status === 429) {
        throw new CoinGeckoError("RATE_LIMITED", `coingecko rate limited: ${path}`, {
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        });
      }
      if (res.status === 404 && opts?.notFoundAsNull) return null;
      throw new CoinGeckoError("UPSTREAM_ERROR", `coingecko ${res.status} on ${path}`, {
        retryable: res.status >= 500,
      });
    }

    try {
      return await res.json();
    } catch (cause) {
      throw new CoinGeckoError("PARSE_ERROR", `coingecko bad json: ${path}`, { cause });
    }
  };
}
