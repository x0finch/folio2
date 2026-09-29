import type { RemoteSql, RemoteStatement } from "@folio/db";

// Cloudflare D1 的 REST API 当作一条 SQL 传输(FOL-85)。GitHub Actions 里没有 D1 绑定,只有 API token;
// 这里把「一条语句 / 一批语句」各翻成一次 HTTPS 往返,上面接的是 `@folio/db` 的 `provideRemoteDbClient`
// —— 差量怎么算、一批塞几条、每条塞几行,全是 `putAll` 自己的事,这一层只管往返与守限。
//
// 用 `/raw` 而不是 `/query`:两者同一个请求体(单条 `{ sql, params }` 或 `{ batch: [...] }`),`/raw`
// 回的行是**值数组**(`{ columns, rows }`),正是 drizzle 的代理驱动要的形状 —— `/query` 回对象,
// 同名列会互相覆盖,还得再按列序拆回数组。
//
// **token 只进 Authorization 头**:报错信息里只有状态码 + Cloudflare 回的 `errors[]`(code + message),
// 不带请求头、不带 URL 以外的任何东西。测试钉着「token 不出现在任何错误里」。

export const D1_API_BASE = "https://api.cloudflare.com/client/v4";

/** D1 一条语句的绑定参数上限。超了 D1 会拒整批 —— 在这里先拦,错误信息说清是谁超了。 */
export const MAX_BOUND_PARAMS = 100;

/**
 * 一次请求体的上限(字节)。D1 自己对单条 SQL 的限制是 100 KB;这里给**整个请求**定一个保守的顶,
 * 让「一批塞太多」在本地就红,而不是在 Cloudflare 那头变成一个含糊的 413。`putAll` 的一批
 * (50 条 × 20 行)实测约 100–150 KB,远在其内。
 */
export const MAX_REQUEST_BYTES = 1_000_000;

/** 瞬时失败(429 / 5xx / 网络断)的总尝试次数与退避基数。写是幂等的(upsert / 按主键删),重发安全。 */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

export interface D1HttpConfig {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
}

// `/raw` 的响应。只声明读到的字段。
interface RawResult {
  readonly results?: { readonly columns?: readonly string[]; readonly rows?: unknown[][] };
  readonly success?: boolean;
}
interface ApiEnvelope {
  readonly success?: boolean;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
  readonly result?: readonly RawResult[];
}

/** API 回的失败。`retryable` 决定要不要再发一次;消息里只有状态码与 Cloudflare 的 errors[]。 */
type D1HttpError = Error & { readonly status: number; readonly retryable: boolean };

const d1Error = (message: string, status: number, retryable: boolean): D1HttpError =>
  Object.assign(new Error(message), { name: "D1HttpError", status, retryable });

const isRetryable = (err: unknown): boolean =>
  err instanceof Error && (err as Partial<D1HttpError>).retryable === true;

const describeErrors = (body: ApiEnvelope | undefined): string =>
  (body?.errors ?? [])
    .map((e) => [e.code, e.message].filter((x) => x !== undefined).join(" "))
    .filter(Boolean)
    .join("; ") || "no error detail";

function checkLimits(stmts: readonly RemoteStatement[], bytes: number): void {
  for (const [i, s] of stmts.entries()) {
    if (s.params.length > MAX_BOUND_PARAMS) {
      throw new Error(
        `statement ${i} binds ${s.params.length} params (D1 limit ${MAX_BOUND_PARAMS}) — split it before sending`,
      );
    }
  }
  if (bytes > MAX_REQUEST_BYTES) {
    throw new Error(
      `request body is ${bytes} bytes (limit ${MAX_REQUEST_BYTES}) for ${stmts.length} statement(s) — send smaller batches`,
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createD1HttpSql(config: D1HttpConfig): RemoteSql {
  const url = `${D1_API_BASE}/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}/raw`;

  // 一次往返(不重试)。成功 → 每条语句一份行数组。
  const once = async (body: string, expected: number): Promise<unknown[][][]> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (err) {
      // 网络层失败(DNS / 连接被断)。原始错误只取 message:undici 的 cause 链里可能带请求选项。
      throw d1Error(
        `D1 API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        0,
        true,
      );
    }
    const parsed = (await res.json().catch(() => undefined)) as ApiEnvelope | undefined;
    if (!res.ok || parsed?.success !== true) {
      const retryable = res.status === 429 || res.status >= 500;
      throw d1Error(`D1 API ${res.status}: ${describeErrors(parsed)}`, res.status, retryable);
    }
    const results = parsed.result ?? [];
    if (results.length !== expected) {
      throw d1Error(
        `D1 API returned ${results.length} result(s) for ${expected} statement(s)`,
        res.status,
        false,
      );
    }
    return results.map((r) => r.results?.rows ?? []);
  };

  const send = async (stmts: readonly RemoteStatement[]): Promise<unknown[][][]> => {
    const payload =
      stmts.length === 1
        ? { sql: stmts[0].sql, params: stmts[0].params }
        : { batch: stmts.map((s) => ({ sql: s.sql, params: s.params })) };
    const body = JSON.stringify(payload);
    checkLimits(stmts, Buffer.byteLength(body));
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(body, stmts.length);
      } catch (err) {
        if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  };

  return {
    query: async (stmt) => (await send([stmt]))[0],
    batch: async (stmts) => (stmts.length === 0 ? [] : send(stmts)),
  };
}
