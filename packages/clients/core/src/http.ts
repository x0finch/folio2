import type { HttpClientError } from "@effect/platform";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Clock, Effect, ParseResult, type RateLimiter, Schema } from "effect";
import { HttpFailure, type SigningFailure } from "./errors";
import { disableBuiltInTracing } from "./http-client";
import { classifyFailure, type UpstreamError } from "./upstream-error";

// Thin HTTP layer: rate-limit → send → classify the failure. Retries are the caller's
// `Effect.retry`: it reruns the whole effect, so each retry re-queues at the gate.

// Retry-After (seconds or HTTP-date) → ms; missing/invalid → undefined.
function parseRetryAfter(header: string | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : undefined;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

const DEFAULT_RATE_LIMITED = [429];

export interface RequestOptions {
  readonly query?: Record<string, string | number | undefined>; // undefined keys are skipped
  readonly method?: "GET" | "POST";
  // Pre-serialized POST body. Deliberately not a `RequestInit`: its headers would clash with
  // the computed ones.
  readonly body?: string;
  // Treat 404 as "no such thing" → null. Only for lookup-by-id endpoints.
  readonly notFoundAsNull?: boolean;
  // Per-request headers; override `HttpConfig.headers`. For clients whose creds vary per call.
  readonly headers?: Effect.Effect<HeadersInit, SigningFailure>;
}

export interface HttpConfig {
  readonly baseUrl: string;
  // Lands in every error's `upstream` field and the span attributes.
  readonly upstream: string;
  // A function because signing headers depend on path/params and can fail. Their failure goes to
  // the error channel unclassified: as a transport fault it would burn retries and hide the cause.
  readonly headers?: (
    path: string,
    options: RequestOptions | undefined,
  ) => Effect.Effect<HeadersInit, SigningFailure>;
  readonly limit?: RateLimiter.RateLimiter; // omitted = unlimited
  readonly rateLimitedStatuses?: readonly number[]; // default [429]
}

// Re-exported so client signatures depend on this package, not on the HTTP library.
export type Outbound = HttpClient.HttpClient;

// `where` comes from the caller (pathname only — the error's URL carries query secrets), and
// `cause` is a summary: the platform error carries the full request, signature and cred headers
// included, when serialized.
const transportFailure =
  (where: string) =>
  (error: HttpClientError.HttpClientError): HttpFailure =>
    error._tag === "ResponseError" && error.reason === "Decode"
      ? new HttpFailure({ kind: "parse", where, cause: summarize(error) })
      : new HttpFailure({ kind: "network", where, cause: summarize(error) });

// Loggable summary of an outbound failure; never pass the library's error object through.
// RequestError keeps the inner message (at most a hostname, and it says why). ResponseError gets
// only the status: a JSON parse message embeds a slice of the response body (user data).
const summarize = (error: HttpClientError.HttpClientError): string => {
  if (error._tag === "ResponseError") {
    return `ResponseError/${error.reason} ${error.response.status}`;
  }
  const inner = error.cause;
  const detail = inner instanceof Error ? inner.message : undefined;
  return detail ? `RequestError/${error.reason}: ${detail}` : `RequestError/${error.reason}`;
};

// Schema failure → path + issue kind only. The default formatter embeds the actual value, which
// is response body.
const whyInvalid = (error: ParseResult.ParseError): string => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  const first = issues[0];
  const at = first && first.path.length > 0 ? first.path.join(".") : "(root)";
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return `schema: ${at} ${first?._tag ?? "Invalid"}${more}`;
};

// Sends a request and returns schema-validated JSON (null on 404 with `notFoundAsNull`).
// The schema declares only the fields we read; extra upstream keys pass through, so an added
// field never breaks a batch. A shape mismatch is `UpstreamParseError` (not retryable).
export interface Requester {
  <A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    options: RequestOptions & { readonly notFoundAsNull: true },
  ): Effect.Effect<A | null, UpstreamError, Outbound>;
  <A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    options?: RequestOptions,
  ): Effect.Effect<A, UpstreamError, Outbound>;
}

export function makeRequester(config: HttpConfig): Requester {
  const rateLimited = new Set(config.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED);
  const classify = classifyFailure({ upstream: config.upstream });

  return (<A, I>(path: string, schema: Schema.Schema<A, I>, options?: RequestOptions) => {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // Errors and spans carry only the pathname: the query holds addresses and signatures.
    const where = url.pathname;
    const method = options?.method ?? "GET";

    const once = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const headerSource = options?.headers ?? config.headers?.(path, options);
      const headers = headerSource ? yield* headerSource : undefined;

      const request = HttpClientRequest.make(method)(url).pipe(
        headers ? HttpClientRequest.setHeaders(headers) : (r) => r,
        options?.body === undefined
          ? (r) => r
          : HttpClientRequest.bodyText(options.body, "application/json"),
      );

      const res = yield* client.execute(request).pipe(Effect.mapError(transportFailure(where)));

      if (res.status < 200 || res.status >= 300) {
        if (rateLimited.has(res.status)) {
          const now = yield* Clock.currentTimeMillis;
          return yield* new HttpFailure({
            kind: "rate-limited",
            where,
            status: res.status,
            retryAfterMs: parseRetryAfter(res.headers["retry-after"], now),
          });
        }
        if (res.status === 401 || res.status === 403) {
          return yield* new HttpFailure({ kind: "auth", where, status: res.status });
        }
        if (res.status === 404 && options?.notFoundAsNull) return null;
        return yield* new HttpFailure({ kind: "upstream", where, status: res.status });
      }

      const body = yield* res.json.pipe(
        // Summary only: this `ResponseError` also carries the full request.
        Effect.mapError(
          (error) => new HttpFailure({ kind: "parse", where, cause: summarize(error) }),
        ),
      );
      return yield* Schema.decodeUnknown(schema)(body).pipe(
        Effect.mapError(
          (error) => new HttpFailure({ kind: "parse", where, cause: whyInvalid(error) }),
        ),
      );
    }).pipe(
      // The built-in span records the full URL, query and all headers (signatures, cred headers
      // not on its redaction list). Disabled here rather than on the layer so any provided
      // `HttpClient` is covered.
      disableBuiltInTracing,
      // Our span: allow-listed attributes only.
      Effect.withSpan("http.client.request", {
        kind: "client",
        attributes: {
          "folio.upstream": config.upstream,
          "http.request.method": method,
          "url.path": where,
        },
      }),
    );

    const gated: Effect.Effect<unknown, HttpFailure | SigningFailure, Outbound> = config.limit
      ? config.limit(once)
      : once;
    return gated.pipe(
      Effect.mapError(classify),
      Effect.map((body) => body as A),
    );
  }) as Requester;
}
