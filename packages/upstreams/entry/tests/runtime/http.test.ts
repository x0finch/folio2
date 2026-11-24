import { Effect, Exit, Fiber, Layer, Schema, Tracer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import { SigningFailure } from "../../src/runtime/errors";
import { makeRequester } from "../../src/runtime/http";
import { httpStub, jsonResponse as json, runClient } from "../../src/runtime/testing";

// Transport tests use a permissive schema; validation has its own block below.
const ANY = Schema.Unknown;

const BASE = "https://up.example.com";
const UPSTREAM = "acme";

const run = <A, E>(
  reply: Parameters<typeof httpStub>[0],
  use: (calls: ReturnType<typeof httpStub>["calls"]) => Effect.Effect<A, E, HttpClient.HttpClient>,
) => {
  const stub = httpStub(reply);
  return runClient(stub, use(stub.calls));
};

const req = (extra?: Partial<Parameters<typeof makeRequester>[0]>) =>
  makeRequester({ baseUrl: BASE, upstream: UPSTREAM, ...extra });

const failing = <A, E>(
  reply: Parameters<typeof httpStub>[0],
  eff: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<E> => run(reply, () => Effect.flip(eff));

describe("makeRequester", () => {
  it("2xx → parsed JSON", async () => {
    expect(
      await run(
        () => json({ ok: 1 }),
        () => req()("/v1/thing", ANY),
      ),
    ).toEqual({ ok: 1 });
  });

  it("appends the query, skipping undefined keys", async () => {
    const stub = httpStub(() => json({}));
    await runClient(stub, req()("/v1/t", ANY, { query: { a: 1, b: "x", c: undefined } }));
    const { url } = stub.calls[0].request;
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.get("b")).toBe("x");
    expect(url.searchParams.has("c")).toBe(false);
  });

  it("request never leaves → upstream unavailable", async () => {
    const err = await failing(
      () => {
        throw new Error("dns");
      },
      req()("/v1/t", ANY),
    );
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe(UPSTREAM);
  });

  it("429 → rate limited, Retry-After seconds parsed to ms", async () => {
    const err = await failing(
      () => json({}, { status: 429, headers: { "retry-after": "3" } }),
      req()("/v1/t", ANY),
    );
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(3000);
  });

  it("accepts Retry-After as an HTTP-date", async () => {
    // TestClock (now = 0) allows an exact assertion; 5000ms is whole seconds, so no precision loss.
    const at = new Date(5000).toUTCString();
    const err = await failing(
      () => json({}, { status: 429, headers: { "retry-after": at } }),
      req()("/v1/t", ANY),
    );
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(5000);
  });

  it("missing / invalid Retry-After → undefined", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "retry-after": "nonsense" },
      { "retry-after": "0" },
    ];
    for (const headers of cases) {
      const err = await failing(() => json({}, { status: 429, headers }), req()("/v1/t", ANY));
      expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBeUndefined();
    }
  });

  it("rateLimitedStatuses is extensible (binance needs 418)", async () => {
    const err = await failing(
      () => json({}, { status: 418 }),
      req({ rateLimitedStatuses: [429, 418] })("/v1/t", ANY),
    );
    expect(err._tag).toBe("UpstreamRateLimitError");
  });

  it("401 / 403 → auth problem", async () => {
    for (const status of [401, 403]) {
      const err = await failing(() => json({}, { status }), req()("/v1/t", ANY));
      expect(err._tag).toBe("UpstreamAuthError");
      expect(err.status).toBe(status);
    }
  });

  it("5xx and 408 → unavailable; 451 → blocked; any other 4xx → refused", async () => {
    const tagOf = async (status: number) =>
      (await failing(() => json({}, { status }), req()("/v1/t", ANY)))._tag;
    expect(await tagOf(503)).toBe("UpstreamUnavailableError");
    expect(await tagOf(408)).toBe("UpstreamUnavailableError");
    expect(await tagOf(451)).toBe("UpstreamBlockedError");
    expect(await tagOf(400)).toBe("UpstreamRefusedError");
    expect(await tagOf(422)).toBe("UpstreamRefusedError");
  });

  it("404 + notFoundAsNull → null (not a failure), and the return type includes null", async () => {
    const reply = () => json({}, { status: 404 });
    // Type-level: the overload with the flag returns `A | null`.
    const out: { readonly id: string } | null = await run(reply, () =>
      req()("/v1/t", Schema.Struct({ id: Schema.String }), { notFoundAsNull: true }),
    );
    expect(out).toBeNull();
    // Without the flag a 404 is still a failure.
    expect((await failing(reply, req()("/v1/t", ANY)))._tag).toBe("UpstreamRefusedError");
  });

  it("non-JSON response → parse error", async () => {
    expect(
      (await failing(() => new Response("<html>", { status: 200 }), req()("/v1/t", ANY)))._tag,
    ).toBe("UpstreamParseError");
  });

  it("sends POST with a body", async () => {
    const stub = httpStub(() => json({}));
    await runClient(stub, req()("/v1/t", ANY, { method: "POST", body: '{"type":"x"}' }));
    expect(stub.calls[0].request.method).toBe("POST");
    expect(stub.calls[0].request.body).toBe('{"type":"x"}');
    // hyperliquid returns 422 without the content-type.
    expect(stub.calls[0].request.headers["content-type"]).toContain("application/json");
  });

  it("client-level headers: computed per request, with path and query (rabby's signing)", async () => {
    const stub = httpStub(() => json({}));
    const request = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: (path, options) =>
        Effect.succeed({ "x-signed": `${path}?${options?.query?.a ?? ""}` }),
    });
    await runClient(stub, request("/v1/t", ANY, { query: { a: "1" } }));
    expect(stub.calls[0].request.headers["x-signed"]).toBe("/v1/t?1");
  });

  it("per-request headers override the client-level ones", async () => {
    const stub = httpStub(() => json({}));
    const request = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: () => Effect.succeed({ "x-key": "client-level" }),
    });
    await runClient(
      stub,
      request("/v1/t", ANY, { headers: Effect.succeed({ "x-key": "per-call" }) }),
    );
    expect(stub.calls[0].request.headers["x-key"]).toBe("per-call");
  });

  it("header computation failure → auth problem, not a transport failure", async () => {
    // As a transport failure it would burn every retry and hide the cause.
    const err = await failing(
      () => json({}),
      req({ headers: () => Effect.fail(new SigningFailure({ where: "sig" })) })("/v1/t", ANY),
    );
    expect(err._tag).toBe("UpstreamAuthError");
  });

  it("every request passes through the gate when one is configured", async () => {
    let passes = 0;
    const limit = Object.assign(
      <A, E, R>(task: Effect.Effect<A, E, R>) => {
        passes++;
        return task;
      },
      {
        forKey:
          () =>
          <A, E, R>(t: Effect.Effect<A, E, R>) =>
            t,
      },
    );
    const request = req({ limit });
    await run(
      () => json({}),
      () => Effect.all([request("/a", ANY), request("/b", ANY)]),
    );
    expect(passes).toBe(2);
  });
});

// Shape validation: a changed upstream shape must fail loudly, not flow through as garbage.
describe("shape validation", () => {
  const Row = Schema.Struct({ id: Schema.String, rank: Schema.optional(Schema.Number) });

  it("lets extra upstream fields through (strict validation would break on any added field)", async () => {
    const got = await run(
      () => json([{ id: "a", rank: 1, brandNewField: 42 }]),
      () => req()("/v1/t", Schema.Array(Row)),
    );
    expect(got).toEqual([{ id: "a", rank: 1 }]);
  });

  it("type change → parse error (not retryable)", async () => {
    const err = await failing(() => json([{ id: 123 }]), req()("/v1/t", Schema.Array(Row)));
    expect(err._tag).toBe("UpstreamParseError");
    // Whole envelope changed (array expected, object given) → also a parse error
    const envelope = await failing(() => json({ id: "a" }), req()("/v1/t", Schema.Array(Row)));
    expect(envelope._tag).toBe("UpstreamParseError");
  });

  it("cause names the path and issue kind, never the actual value", async () => {
    // The actual value is response body; Effect's default formatter would embed it.
    const err = await failing(
      () => json([{ id: "ok" }, { id: "0xdeadbeef-secret-ish" }, { id: 1 }]),
      req()("/v1/t", Schema.Array(Schema.Struct({ id: Schema.String }))),
    );
    expect(String(err.cause)).toContain("2.id"); // id of row 3
    expect(String(err.cause)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(err)).not.toContain("0xdeadbeef");
  });

  it("`notFoundAsNull` with validation: 404 → null, validation skipped", async () => {
    const got = await run(
      () => json({}, { status: 404 }),
      () => req()("/v1/t", Row, { notFoundAsNull: true }),
    );
    expect(got).toBeNull();
  });
});

// The built-in span records full URL, query and all headers; its redaction list misses our key headers.
// `http-client.ts` disables it and adds an allow-listed span — pinned here.
describe("red line: what may be recorded", () => {
  const captureSpans = () => {
    const spans: { name: string; attributes: Map<string, unknown> }[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const attributes = new Map<string, unknown>();
        spans.push({ name: options.name, attributes });
        const record = span.attribute.bind(span);
        span.attribute = (key, value) => {
          attributes.set(key, value);
          record(key, value);
        };
        return span;
      },
    });
    return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
  };

  const SECRET_QUERY = { address: "0xdeadbeef", signature: "s3cr3t-signature" };

  const SECRET_HEADERS = { "x-mbx-apikey": "s3cr3t-key" };

  // Serialize the whole error: the leak once went out via `cause` while `where` was correct.
  const clean = (err: unknown) => {
    const dumped = JSON.stringify(err);
    expect(dumped).not.toContain("0xdeadbeef"); // address in the query
    expect(dumped).not.toContain("s3cr3t-signature"); // signature in the query
    expect(dumped).not.toContain("s3cr3t-key"); // cred header value
    expect(dumped).not.toContain("x-mbx-apikey"); // not even the header name
  };

  it("failures carry the pathname, not the query", async () => {
    const err = await failing(
      () => json({}, { status: 503 }),
      req()("/v1/t", ANY, { query: SECRET_QUERY }),
    );
    expect(err.where).toBe("/v1/t");
    clean(err);
  });

  // Only network and parse failures carry a `cause`, and the platform errors behind them hold the
  // full request (URL, query, all headers).
  it("network failure → cause has no query and no cred headers", async () => {
    const err = await failing(
      () => {
        throw new Error("getaddrinfo ENOTFOUND up.example.com");
      },
      req({ headers: () => Effect.succeed(SECRET_HEADERS) })("/v1/t", ANY, { query: SECRET_QUERY }),
    );
    clean(err);
    // Still says which kind and why — that's what debugging needs.
    expect(String(err.cause)).toContain("TransportError");
    expect(String(err.cause)).toContain("ENOTFOUND");
  });

  it("parse failure (non-JSON) → equally clean, and no response body", async () => {
    const err = await failing(
      () => new Response("<html>upstream is down</html>", { status: 200 }),
      req({ headers: () => Effect.succeed(SECRET_HEADERS) })("/v1/t", ANY, { query: SECRET_QUERY }),
    );
    clean(err);
    expect(err._tag).toBe("UpstreamParseError");
    // JSON parse messages embed a slice of the body; keep it out of the error.
    expect(JSON.stringify(err)).not.toContain("upstream is down");
  });

  it("span has no query, no full URL, no request headers", async () => {
    const { spans, layer } = captureSpans();
    const stub = httpStub(() => json({ ok: 1 }));
    const request = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: () => Effect.succeed({ "x-mbx-apikey": "s3cr3t-key" }),
    });

    await request("/v1/t", ANY, { query: SECRET_QUERY }).pipe(
      Effect.provide(layer),
      Effect.provide(stub.layer),
      Effect.runPromise,
    );

    expect(spans.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(spans.map((s) => [s.name, [...s.attributes]]));
    expect(dumped).not.toContain("s3cr3t-signature"); // signature in the query
    expect(dumped).not.toContain("0xdeadbeef"); // address in the query
    expect(dumped).not.toContain("s3cr3t-key"); // cred header
    expect(dumped).not.toContain("x-mbx-apikey"); // not even the header name

    const ours = spans.find((s) => s.name === "http.client.request");
    expect(ours).toBeDefined();
    expect(ours?.attributes.get("folio.upstream")).toBe(UPSTREAM);
    expect(ours?.attributes.get("url.path")).toBe("/v1/t");
    expect(ours?.attributes.get("http.request.method")).toBe("GET");
  });

  it("outbound requests carry no traceparent (internal trace ids stay internal)", async () => {
    const { layer } = captureSpans();
    const stub = httpStub(() => json({}));
    await req()("/v1/t", ANY).pipe(
      Effect.provide(layer),
      Effect.provide(stub.layer),
      Effect.runPromise,
    );
    expect(Object.keys(stub.calls[0].request.headers)).not.toContain("traceparent");
    expect(Object.keys(stub.calls[0].request.headers)).not.toContain("b3");
  });
});

describe("interruption aborts the underlying request", () => {
  it("interrupted effect → fetch's AbortSignal fires", async () => {
    let signal: AbortSignal | undefined;
    const client = HttpClient.make((_request, _url, s) => {
      signal = s;
      // Never replies; only interruption ends it.
      return Effect.never;
    });

    const exit = await Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(req()("/v1/slow", ANY));
      // Let the request go out (stub records the signal), then interrupt.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.runPromise);

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it("a normal completion does not abort", async () => {
    let signal: AbortSignal | undefined;
    const client = HttpClient.make((request, _url, s) => {
      signal = s;
      return Effect.succeed(HttpClientResponse.fromWeb(request, json({ ok: 1 })));
    });

    const out = await req()("/v1/t", ANY).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.runPromise,
    );

    expect(out).toEqual({ ok: 1 });
    expect(signal?.aborted).toBe(false);
  });
});
