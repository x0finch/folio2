import { createHttpClient, type Failure, type Fetcher } from "@folio/shared";
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
// **刻意中性:不带项目名、不带仓库地址。**
// 这些请求打的是第三方(Trezor 的公共节点、CoinGecko),而请求内容本身就是敏感的 ——
// blockbook 那条带着 **xpub**(整个钱包的观察密钥)。UA 里写上「这是某某项目、作者在这个
// GitHub」等于把「谁在看这个地址」和一个具体的人绑在一起,而且让所有自托管实例可被归成一类。
//
// **不能直接不发**:CGK 的 Cloudflare WAF 对无 UA 请求返 403(Workers 的 fetch 默认不带 UA),
// 这是仓库里记着的坑。所以给一个最常见、什么都不说的值 —— 它是「未指明客户端」的事实标准,
// 过 WAF 没问题,而且因为太常见反而不构成指纹。
export const USER_AGENT = "Mozilla/5.0";

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

// 失败归类由 @folio/shared 的 http 包装做,这里只负责变成 blockbook 自己的错误类型。
// `retryable` 决定的是**要不要换下一个端点**(见 request 的循环),不是要不要退避重试。
function toFailure({ kind, where, status, retryAfterMs, cause }: Failure): BlockbookError {
  if (kind === "network")
    return new BlockbookError("UPSTREAM_ERROR", "blockbook request failed", { cause });
  if (kind === "auth")
    return new BlockbookError("AUTH_FAILED", `blockbook auth failed (${status})`);
  if (kind === "rate-limited")
    return new BlockbookError("RATE_LIMITED", "blockbook rate limited", { retryAfterMs });
  if (kind === "parse")
    return new BlockbookError("PARSE_ERROR", `blockbook returned invalid JSON (${where})`, {
      cause,
    });
  if ((status ?? 0) >= 500)
    return new BlockbookError("UPSTREAM_ERROR", `blockbook upstream error (${status})`);
  // 4xx(非 401/403/429):如无效 xpub → 不可重试,别浪费其它端点。
  return new BlockbookError("UPSTREAM_ERROR", `blockbook error (${status})`, { retryable: false });
}

// 一个 base 一个 client,**懒建 + 模块级缓存**。
// 不 eager 建全部:一次调用通常只碰一个端点(换端点只在出错时才发生),而
// `createBlockbookClient()` 是**每个账户每轮同步都调一次**的 —— eager 的话每次白建 4 个。
// 缓存放模块级而不是函数内,否则每次调用还是重建。key 带上 userAgent,因为它可配。
const clients = new Map<string, Fetcher>();

function clientFor(base: string, userAgent: string): Fetcher {
  const key = `${userAgent}\n${base}`;
  let client = clients.get(key);
  if (!client) {
    client = createHttpClient({
      baseUrl: base,
      headers: () => ({ "user-agent": userAgent, accept: "application/json" }),
      toFailure,
      // **不传 retry** —— 这个 client 的「重试」就是换下一个端点(见 request)。两个都开的话
      // 每个端点先自己退避几次再换下一个,延迟直接乘起来。
    });
    clients.set(key, client);
  }
  return client;
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
  // **这个循环就是 blockbook 的「重试」** —— 它是「换哪个端点」的策略,不是「一个请求怎么发」,
  // 所以留在这儿而不是塞进共享包装(混在一起,读代码的人第一个问题就会是「谁先发生」)。
  async function request<T>(path: string): Promise<T> {
    const start = cursor++ % bases.length;
    let lastErr: BlockbookError | undefined;
    for (let i = 0; i < bases.length; i++) {
      try {
        return (await clientFor(bases[(start + i) % bases.length], userAgent)(path)) as T;
      } catch (err) {
        const e = err as BlockbookError;
        if (!e.retryable) throw e;
        lastErr = e;
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
