import type { UpstreamError } from "@folio/upstream-basic";
import { Clock, Effect, Schema, type SchemaIssue, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { HttpFailure, type HttpFailureKind, SigningFailure } from "./errors";
import { disableBuiltInTracing } from "./http-client";
import type { RateLimit } from "./ratelimit";
import { classifyFailure } from "./upstream-error";

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
const GEO_BLOCKED_STATUS = 451;
const REQUEST_TIMEOUT_STATUS = 408;

const kindOfStatus = (status: number): HttpFailureKind => {
  if (status === GEO_BLOCKED_STATUS) return "blocked";
  if (status >= 400 && status < 500 && status !== REQUEST_TIMEOUT_STATUS) return "refused";
  return "upstream";
};

export interface RequestOptions {
  readonly query?: Record<string, string | number | undefined>; // undefined keys are skipped
  readonly method?: "GET" | "POST";
  // Pre-serialized POST body. Deliberately not a `RequestInit`: its headers would clash with
  // the computed ones.
  readonly body?: string;
  // Treat 404 as "no such thing" → null. Only for lookup-by-id endpoints.
  readonly notFoundAsNull?: boolean;
  // Per-request headers, merged over `HttpConfig.headers`. For clients whose creds vary per call.
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
  readonly limit?: RateLimit; // omitted = unlimited
  readonly rateLimitedStatuses?: readonly number[]; // default [429]
  // A 3xx is `refused` instead of followed, so the request can only reach the host it names.
  readonly refuseRedirects?: boolean;
  // A body over this many bytes is `refused`; it is counted while read, never buffered whole first.
  readonly maxBodyBytes?: number;
}

const mergeHeaders = (
  shared: HeadersInit | undefined,
  own: HeadersInit | undefined,
): Record<string, string> => {
  const merged = new Headers(shared);
  new Headers(own).forEach((value, name) => {
    merged.set(name, value);
  });
  return Object.fromEntries(merged);
};

// Re-exported so client signatures depend on this package, not on the HTTP library.
export type Outbound = HttpClient.HttpClient;

// `where` comes from the caller (pathname only — the error's URL carries query secrets), and
// `cause` is a summary: the platform error carries the full request, signature and cred headers
// included, when serialized.
const transportFailure =
  (where: string) =>
  (error: HttpClientError.HttpClientError): HttpFailure =>
    error.reason._tag === "DecodeError"
      ? new HttpFailure({ kind: "parse", where, cause: summarize(error) })
      : new HttpFailure({ kind: "network", where, cause: summarize(error) });

// Loggable summary of an outbound failure; never pass the library's error object through.
// A request-side reason keeps the inner message (at most a hostname, and it says why). A
// response-side reason gets only the status: a JSON parse message embeds a slice of the response
// body (user data).
const summarize = (error: HttpClientError.HttpClientError): string => {
  const reason = error.reason;
  if ("response" in reason) return `${reason._tag} ${reason.response.status}`;
  const detail = reason.cause instanceof Error ? reason.cause.message : undefined;
  return detail ? `${reason._tag}: ${detail}` : reason._tag;
};

// Schema failure → path + issue kind only. The default formatter embeds the actual value, which
// is response body.
const whyInvalid = (error: Schema.SchemaError): string => {
  const leaves = leavesOf(error.issue, []);
  const first = leaves[0];
  const at = first && first.path.length > 0 ? first.path.map(String).join(".") : "(root)";
  const more = leaves.length > 1 ? ` (+${leaves.length - 1} more)` : "";
  return `schema: ${at} ${first?.tag ?? "Invalid"}${more}`;
};

const leavesOf = (
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[],
): { readonly path: readonly PropertyKey[]; readonly tag: string }[] => {
  switch (issue._tag) {
    case "Pointer":
      return leavesOf(issue.issue, [...path, ...issue.path]);
    case "Filter":
    case "Encoding":
      return leavesOf(issue.issue, path);
    case "Composite":
    case "AnyOf":
      return issue.issues.flatMap((inner) => leavesOf(inner, path));
    default:
      return [{ path, tag: issue._tag }];
  }
};

const isRedirect = (status: number): boolean =>
  // `redirect: "manual"` yields 0 (an opaque redirect) in browsers and the 3xx itself on workerd.
  status === 0 || (status >= 300 && status < 400);

const oversized = (where: string, max: number) =>
  new HttpFailure({ kind: "refused", where, cause: `body over ${max} bytes` });

// Ending a started body stream aborts the request, freeing the connection now rather than at GC.
// One chunk is pulled so the stream starts; detached, so a stalled body never delays the verdict.
const release = (res: HttpClientResponse.HttpClientResponse): Effect.Effect<void> =>
  Effect.asVoid(Effect.forkDetach(Stream.runDrain(Stream.take(res.stream, 1)).pipe(Effect.ignore)));

const readCappedJson = (
  res: HttpClientResponse.HttpClientResponse,
  where: string,
  max: number,
): Effect.Effect<unknown, HttpFailure> =>
  Effect.gen(function* () {
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      yield* release(res);
      return yield* oversized(where, max);
    }
    const { parts, size } = yield* Stream.runFoldEffect(
      res.stream,
      () => ({ parts: [] as Uint8Array[], size: 0 }),
      (acc, chunk) => {
        acc.size += chunk.length;
        if (acc.size > max) return Effect.fail(oversized(where, max));
        acc.parts.push(chunk);
        return Effect.succeed(acc);
      },
    ).pipe(
      Effect.mapError((error) =>
        error instanceof HttpFailure
          ? error
          : new HttpFailure({ kind: "parse", where, cause: summarize(error) }),
      ),
    );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const text = new TextDecoder().decode(bytes);
    return yield* Effect.try({
      try: (): unknown => (text === "" ? null : JSON.parse(text)),
      // No parser message: it quotes a slice of the body.
      catch: () => new HttpFailure({ kind: "parse", where, cause: "body is not JSON" }),
    });
  });

// Sends a request and returns schema-validated JSON (null on 404 with `notFoundAsNull`).
// The schema declares only the fields we read; extra upstream keys pass through, so an added
// field never breaks a batch. A shape mismatch is `UpstreamParseError` (not retryable).
export interface Requester {
  <A, I>(
    path: string,
    schema: Schema.Codec<A, I>,
    options: RequestOptions & { readonly notFoundAsNull: true },
  ): Effect.Effect<A | null, UpstreamError, Outbound>;
  <A, I>(
    path: string,
    schema: Schema.Codec<A, I>,
    options?: RequestOptions,
  ): Effect.Effect<A, UpstreamError, Outbound>;
}

export function makeRequester(config: HttpConfig): Requester {
  const rateLimited = new Set(config.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED);
  const classify = classifyFailure({ upstream: config.upstream });

  return (<A, I>(path: string, schema: Schema.Codec<A, I>, options?: RequestOptions) => {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // Errors and spans carry only the pathname: the query holds addresses and signatures.
    const where = url.pathname;
    const method = options?.method ?? "GET";

    const once = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const shared = config.headers ? yield* config.headers(path, options) : undefined;
      const own = options?.headers ? yield* options.headers : undefined;
      // A value `Headers` won't take (a pasted key with a newline or a non-Latin-1 character)
      // would throw; it is the credential that's wrong.
      const headers =
        shared || own
          ? yield* Effect.try({
              try: () => mergeHeaders(shared, own),
              catch: () => new SigningFailure({ where, cause: "header value not sendable" }),
            })
          : undefined;

      const request = HttpClientRequest.make(method)(url).pipe(
        headers ? HttpClientRequest.setHeaders(headers) : (r) => r,
        options?.body === undefined
          ? (r) => r
          : HttpClientRequest.bodyText(options.body, "application/json"),
      );

      const sent = client.execute(request).pipe(Effect.mapError(transportFailure(where)));
      const res = yield* config.refuseRedirects
        ? Effect.provideService(sent, FetchHttpClient.RequestInit, { redirect: "manual" })
        : sent;

      if (config.refuseRedirects && isRedirect(res.status)) {
        yield* release(res);
        return yield* new HttpFailure({
          kind: "refused",
          where,
          status: res.status,
          cause: "redirect",
        });
      }
      if (res.status < 200 || res.status >= 300) {
        // Nothing reads an error body; close it now rather than hold the connection until GC.
        yield* release(res);
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
        return yield* new HttpFailure({
          kind: kindOfStatus(res.status),
          where,
          status: res.status,
        });
      }

      const body =
        config.maxBodyBytes === undefined
          ? yield* res.json.pipe(
              // Summary only: this `ResponseError` also carries the full request.
              Effect.mapError(
                (error) => new HttpFailure({ kind: "parse", where, cause: summarize(error) }),
              ),
            )
          : yield* readCappedJson(res, where, config.maxBodyBytes);
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
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
