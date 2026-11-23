import type { RemoteSql, RemoteStatement } from "@folio/db";

// Cloudflare D1's REST API as a SQL transport: GitHub Actions has no D1 binding, only an API token. Each statement or batch is one HTTPS round trip, under `@folio/db`'s `provideRemoteDbClient`; diffing and batching belong to `putAll`.
//
// `/raw` rather than `/query`: same request body, but `/raw` returns rows as value arrays (`{ columns, rows }`), the shape drizzle's proxy driver wants; `/query` returns objects whose duplicate column names overwrite each other.
//
// The token goes only in the Authorization header; errors carry only the status and Cloudflare's `errors[]` (code + message). Tests pin that the token appears in no error.

export const D1_API_BASE = "https://api.cloudflare.com/client/v4";

/** D1's bound-parameter cap per statement; over it D1 rejects the whole batch, so check here and name the offender. */
export const MAX_BOUND_PARAMS = 100;

/** Request body cap in bytes. D1 limits one SQL statement to 100 KB; this is a conservative cap on the whole request so oversized batches fail locally instead of as a vague 413 (a `putAll` batch is ~100-150 KB). */
export const MAX_REQUEST_BYTES = 1_000_000;

/** Attempts and backoff base for transient failures (429 / 5xx / network). Writes are idempotent (upsert / delete by PK), so resending is safe. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;

export interface D1HttpConfig {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
}

// `/raw` response; only the fields we read.
interface RawResult {
  readonly results?: { readonly columns?: readonly string[]; readonly rows?: unknown[][] };
  readonly success?: boolean;
}
interface ApiEnvelope {
  readonly success?: boolean;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
  readonly result?: readonly RawResult[];
}

/** An API failure. `retryable` decides whether to resend; the message holds only the status and Cloudflare's errors[]. */
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

  // One round trip (no retry). On success, one row array per statement.
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
      // Network-layer failure (DNS / dropped connection). Take only the message: undici's cause chain can carry request options.
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
