// 低层 HTTP(内部)——拼 URL/头 + 错误映射 + 限速闸/重试,不对外导出 request;
// SDK 方法建于其上(见 client.ts)。含两处 CF Workers 修复:
//   ① 注入 User-Agent —— CGK 的 Cloudflare WAF 对无 UA 请求返 403(Workers fetch 默认不带 UA)。
//   ② 直接用全局 `fetch`(不存成方法/this,避免 Workers 的 illegal invocation)。

import { defineLimit, type Limit, type LimitLogger, withRetry } from "@folio/ratelimit";
import {
  CG_BURST,
  CG_CALLS_PER_MIN_DEMO,
  CG_CALLS_PER_MIN_KEYLESS,
  CG_CALLS_PER_MIN_PRO,
  CG_LIMIT_KEY,
  CG_LIMIT_KEY_KEYLESS,
  CG_RETRY_ATTEMPTS,
  CG_RETRY_BASE_MS,
  CG_RETRY_MAX_WAIT_MS,
} from "./constants";

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
  // 限速闸和重试的等待实现。生产不传(用 setTimeout);**测试注入即时版** —— 否则闸会让测试真等。
  sleep?: (ms: number) => Promise<void>;
  // 结构化日志钩子。传了才会报出「colo 档冷却没生效」——`*.workers.dev` 上 Cache API 的
  // put/match 是静默 no-op(见 apps/web/DEPLOY.md),不传就永远不知道那一层是死的。
  log?: LimitLogger;
}

type Query = Record<string, string | number | undefined>;
interface RequestOptions {
  notFoundAsNull?: boolean;
}

// 内部低层 GET:404 且 notFoundAsNull → null,其余非 2xx / 网络 / 坏 JSON 抛 CoinGeckoError。
export type Requester = (path: string, query?: Query, opts?: RequestOptions) => Promise<unknown>;

// 限速策略。**闸和重试都建在这一层**,不在各 SDK 方法里 —— 一处接上,10 个方法一起受益。
//
// 为什么 CGK 最需要闸:一把 key 全部署共用,所有用户的每次调用都花同一份额度(目录预热 4 页、
// 建 ref 索引时 Promise.all 两发、搜索、按需取价、历史序列)。跟「每账户各花自己的」正好相反。
//
// scope 取 colo:撞墙之后同一个数据中心的 isolate 一起收手(冷却标记只止损、不管配额)。
// 精确到「跨 colo 的一把 key」要 Durable Object,见 #17 —— 那一档在自托管量级用不上。
function limitFor(config: CoinGeckoConfig): Limit {
  const callsPerMin = config.pro
    ? CG_CALLS_PER_MIN_PRO
    : config.apiKey
      ? CG_CALLS_PER_MIN_DEMO
      : CG_CALLS_PER_MIN_KEYLESS;
  return defineLimit({
    key: config.apiKey ? CG_LIMIT_KEY : CG_LIMIT_KEY_KEYLESS,
    scope: "colo",
    capacity: CG_BURST,
    ratePerSec: callsPerMin / 60,
    sleep: config.sleep,
    log: config.log,
    // 冷却期内抛本包自己的错误类型 —— 调用方(oracle / oracle2)只认识 CoinGeckoError。
    onCooldown: (remainingMs) => {
      throw new CoinGeckoError("RATE_LIMITED", "coingecko cooling down after a rate limit", {
        retryAfterMs: remainingMs,
      });
    },
  });
}

// 对外的 requester:限速闸 + 重试 **包在** 低层 GET 外面。
//
// 包一层而不是在 fetch 里加 for 循环,是为了让错误映射那段保持纯的(Response → 错误对象)——
// 于是测重试时压根不用碰 fetch,测映射时压根不用碰闸。
export function createRequester(config: CoinGeckoConfig = {}): Requester {
  const raw = createRawRequester(config);
  const limit = limitFor(config);

  return async (path, query, opts) => {
    try {
      return await withRetry(
        async () => {
          await limit.acquire(); // 冷却期内这里就抛,压根不出网
          return raw(path, query, opts);
        },
        {
          attempts: CG_RETRY_ATTEMPTS,
          maxWaitMs: CG_RETRY_MAX_WAIT_MS,
          baseMs: CG_RETRY_BASE_MS,
          sleep: config.sleep,
          // exceedsMaxWait 用默认的 "throw":这条路可能挂在用户的写路径上(见 constants.ts)。
        },
      );
    } catch (error) {
      // **冷却写在重试之外,不在里面。** 写在里面的话它会把自己那次重试也拦掉:冷却时长取
      // Retry-After(缺了就取包里的保守默认 5s),而退避只有 250ms —— 于是重试永远撞在自己写下
      // 的冷却上,一次都成功不了。
      //
      // 语义上外面也才是对的:冷却是**放弃信号**,不是第一次踉跄的信号。重试成功了的那一次
      // 429 说明是瞬时抖动,没必要让别的调用者也停;连重试都没救回来才说明该集体收手。
      // 由调用方显式写,包不去嗅探 Response(那会让 @folio/ratelimit 依赖 HTTP 语义)。
      if (error instanceof CoinGeckoError && error.code === "RATE_LIMITED") {
        await limit.cooldown(error.retryAfterMs);
      }
      throw error;
    }
  };
}

function createRawRequester(config: CoinGeckoConfig): Requester {
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
