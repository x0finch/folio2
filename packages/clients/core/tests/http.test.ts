import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Exit, Fiber, Layer, Tracer } from "effect";
import { describe, expect, it } from "vitest";
import { SigningFailure } from "../src/errors";
import { makeRequester } from "../src/http";
import { httpStub, jsonResponse as json, runClient } from "../src/testing";

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
  it("2xx → 解析好的 JSON", async () => {
    expect(
      await run(
        () => json({ ok: 1 }),
        () => req()("/v1/thing"),
      ),
    ).toEqual({ ok: 1 });
  });

  it("query 拼上,undefined 的键不参与", async () => {
    const stub = httpStub(() => json({}));
    await runClient(stub, req()("/v1/t", { query: { a: 1, b: "x", c: undefined } }));
    const { url } = stub.calls[0].request;
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.get("b")).toBe("x");
    expect(url.searchParams.has("c")).toBe(false);
  });

  it("出不去 → 够不到上游", async () => {
    const err = await failing(() => {
      throw new Error("dns");
    }, req()("/v1/t"));
    // 出口就是最终错误面 —— 不再是 `HttpFailure` 那个中间态。
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe(UPSTREAM);
  });

  it("429 → 限流,Retry-After 秒数解析成毫秒", async () => {
    const err = await failing(
      () => json({}, { status: 429, headers: { "retry-after": "3" } }),
      req()("/v1/t"),
    );
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(3000);
  });

  it("Retry-After 是 HTTP-date 也认", async () => {
    // 跑在 `TestClock` 上(now = 0),所以这里能断言**精确值**而不是一个窗口 ——
    // 时序测试不该赌墙钟。HTTP-date 是秒级精度,5000ms 正好整秒,来回不丢精度。
    const at = new Date(5000).toUTCString();
    const err = await failing(
      () => json({}, { status: 429, headers: { "retry-after": at } }),
      req()("/v1/t"),
    );
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(5000);
  });

  it("Retry-After 缺失 / 无效 → undefined", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "retry-after": "nonsense" },
      { "retry-after": "0" },
    ];
    for (const headers of cases) {
      const err = await failing(() => json({}, { status: 429, headers }), req()("/v1/t"));
      expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBeUndefined();
    }
  });

  it("rateLimitedStatuses 可加(binance 要认 418)", async () => {
    const err = await failing(
      () => json({}, { status: 418 }),
      req({ rateLimitedStatuses: [429, 418] })("/v1/t"),
    );
    expect(err._tag).toBe("UpstreamRateLimitError");
  });

  it("401 / 403 → 凭据问题", async () => {
    for (const status of [401, 403]) {
      const err = await failing(() => json({}, { status }), req()("/v1/t"));
      expect(err._tag).toBe("UpstreamAuthError");
      expect(err.status).toBe(status);
    }
  });

  it("其余非 2xx → 够不到上游", async () => {
    expect((await failing(() => json({}, { status: 503 }), req()("/v1/t")))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("404 + notFoundAsNull → null(不是故障),且**返回类型自己带上 null**", async () => {
    const reply = () => json({}, { status: 404 });
    // 类型层面钉住:开了开关的重载返回 `A | null`,不靠调用方在类型参数里手写 `| null`。
    const out: { id: string } | null = await run(reply, () =>
      req()<{ id: string }>("/v1/t", { notFoundAsNull: true }),
    );
    expect(out).toBeNull();
    // 不开这个开关时 404 仍是故障。
    expect((await failing(reply, req()("/v1/t")))._tag).toBe("UpstreamUnavailableError");
  });

  it("回来的不是 JSON → 读不动", async () => {
    expect(
      (await failing(() => new Response("<html>", { status: 200 }), req()("/v1/t")))._tag,
    ).toBe("UpstreamParseError");
  });

  it("POST + body 发得出去", async () => {
    const stub = httpStub(() => json({}));
    await runClient(stub, req()("/v1/t", { method: "POST", body: '{"type":"x"}' }));
    expect(stub.calls[0].request.method).toBe("POST");
    expect(stub.calls[0].request.body).toBe('{"type":"x"}');
    // body 带上 content-type,少了它 hyperliquid 回 422。
    expect(stub.calls[0].request.headers["content-type"]).toContain("application/json");
  });

  it("client 级的头:每一发都算一次,拿得到 path 和 query(rabby 的签名靠这个)", async () => {
    const stub = httpStub(() => json({}));
    const request = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: (path, options) =>
        Effect.succeed({ "x-signed": `${path}?${options?.query?.a ?? ""}` }),
    });
    await runClient(stub, request("/v1/t", { query: { a: "1" } }));
    expect(stub.calls[0].request.headers["x-signed"]).toBe("/v1/t?1");
  });

  it("每请求的头**覆盖** client 级那份 —— 凭据每请求不同的五家走这条", async () => {
    const stub = httpStub(() => json({}));
    const request = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: () => Effect.succeed({ "x-key": "client-level" }),
    });
    await runClient(stub, request("/v1/t", { headers: Effect.succeed({ "x-key": "per-call" }) }));
    expect(stub.calls[0].request.headers["x-key"]).toBe("per-call");
  });

  it("头算不出来 → 归「凭据问题」,不被归类成传输故障", async () => {
    // 归错了会退化成「三次退避全白打」,还把真正的原因盖掉(rabby 的 wasm 签名靠这条)。
    const err = await failing(
      () => json({}),
      req({ headers: () => Effect.fail(new SigningFailure({ where: "sig" })) })("/v1/t"),
    );
    expect(err._tag).toBe("UpstreamAuthError");
  });

  it("闸装上时每一发都过闸", async () => {
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
      () => Effect.all([request("/a"), request("/b")]),
    );
    expect(passes).toBe(2);
  });
});

// —— 原则 #5 的红线。**这一组是换用官方 `HttpClient` 的验收条件** ——
//
// 官方客户端默认会把完整 URL、query 和全部请求头写进它内建的 span,而它的默认脱敏名单
// (`["authorization","cookie","set-cookie","x-api-key"]`)不含我们六个上游的 key 头。
// `http-client.ts` 把内建 tracing 整个关掉、自己加一个只写白名单属性的 span —— 下面钉住这件事。
describe("红线:什么能被记下来", () => {
  // 记下所有 span 的名字和属性。
  const captureSpans = () => {
    const spans: { name: string; attributes: Map<string, unknown> }[] = [];
    const tracer = Tracer.make({
      span: (name, parent, context, links, startTime, kind) => {
        const attributes = new Map<string, unknown>();
        spans.push({ name, attributes });
        const span: Tracer.Span = {
          _tag: "Span",
          name,
          spanId: `span-${spans.length}`,
          traceId: "trace",
          parent,
          context,
          links,
          status: { _tag: "Started", startTime },
          attributes,
          sampled: true,
          kind,
          end: () => {},
          attribute: (key, value) => {
            attributes.set(key, value);
          },
          event: () => {},
          addLinks: () => {},
        };
        return span;
      },
      context: (f) => f(),
    });
    return { spans, layer: Layer.setTracer(tracer) };
  };

  const SECRET_QUERY = { address: "0xdeadbeef", signature: "s3cr3t-signature" };

  const SECRET_HEADERS = { "x-mbx-apikey": "s3cr3t-key" };

  // 序列化整个错误对象来查 —— 断言某个字段干净是不够的:泄的那次正是从**没人看的 `cause`**
  // 里出去的,而 `where` 一直是对的。
  const clean = (err: unknown) => {
    const dumped = JSON.stringify(err);
    expect(dumped).not.toContain("0xdeadbeef"); // query 里的地址
    expect(dumped).not.toContain("s3cr3t-signature"); // query 里的签名
    expect(dumped).not.toContain("s3cr3t-key"); // 凭据头的值
    expect(dumped).not.toContain("x-mbx-apikey"); // 连头的名字都不该出现
  };

  it("失败信息只带 pathname,不带 query", async () => {
    const err = await failing(
      () => json({}, { status: 503 }),
      req()("/v1/t", { query: SECRET_QUERY }),
    );
    expect(err.where).toBe("/v1/t");
    clean(err);
  });

  // **这条和下一条是补的**:上面那条打的是 503,而 503 走的分支压根不带 `cause`。
  // 带 `cause` 的只有「没出去」和「读不动」两条,而官方那两个错误对象身上挂着完整 `request`
  // (URL + query + 全部请求头)—— 原样透传就等于让签名和 API key 跟着错误到处走。
  it("**没出去**(网络失败)→ cause 里没有 query、没有凭据头", async () => {
    const err = await failing(
      () => {
        throw new Error("getaddrinfo ENOTFOUND up.example.com");
      },
      req({ headers: () => Effect.succeed(SECRET_HEADERS) })("/v1/t", { query: SECRET_QUERY }),
    );
    clean(err);
    // 该留的还留着:是哪一类、为什么 —— 排障要的就是这一句。
    expect(String(err.cause)).toContain("RequestError");
    expect(String(err.cause)).toContain("ENOTFOUND");
  });

  it("**读不动**(响应不是 JSON)→ 同样干净,而且不带响应正文", async () => {
    const err = await failing(
      () => new Response("<html>upstream is down</html>", { status: 200 }),
      req({ headers: () => Effect.succeed(SECRET_HEADERS) })("/v1/t", { query: SECRET_QUERY }),
    );
    clean(err);
    expect(err._tag).toBe("UpstreamParseError");
    // 正文不跟着走:JSON 解析错误的 message 会把正文的一截拼进去。它不是凭据,
    // 但也没有理由挂在一个到处传的错误对象上。
    expect(JSON.stringify(err)).not.toContain("upstream is down");
  });

  it("**span 里没有 query、没有完整 URL、没有任何请求头**", async () => {
    const { spans, layer } = captureSpans();
    const stub = httpStub(() => json({ ok: 1 }));
    const request = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: () => Effect.succeed({ "x-mbx-apikey": "s3cr3t-key" }),
    });

    await request("/v1/t", { query: SECRET_QUERY }).pipe(
      Effect.provide(layer),
      Effect.provide(stub.layer),
      Effect.runPromise,
    );

    expect(spans.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(spans.map((s) => [s.name, [...s.attributes]]));
    expect(dumped).not.toContain("s3cr3t-signature"); // query 里的签名
    expect(dumped).not.toContain("0xdeadbeef"); // query 里的地址
    expect(dumped).not.toContain("s3cr3t-key"); // 凭据头
    expect(dumped).not.toContain("x-mbx-apikey"); // 连头的**名字**都不该出现

    // 该有的还是有:白名单那三个属性。
    const ours = spans.find((s) => s.name === "http.client.request");
    expect(ours).toBeDefined();
    expect(ours?.attributes.get("folio.upstream")).toBe(UPSTREAM);
    expect(ours?.attributes.get("url.path")).toBe("/v1/t");
    expect(ours?.attributes.get("http.request.method")).toBe("GET");
  });

  it("**出站请求不带 traceparent** —— 不把内部 trace id 发给上游", async () => {
    const { layer } = captureSpans();
    const stub = httpStub(() => json({}));
    await req()("/v1/t").pipe(Effect.provide(layer), Effect.provide(stub.layer), Effect.runPromise);
    expect(Object.keys(stub.calls[0].request.headers)).not.toContain("traceparent");
    expect(Object.keys(stub.calls[0].request.headers)).not.toContain("b3");
  });
});

// 手搓 `Effect.tryPromise` 收不到 signal —— 上层超时后请求还在飞,上游的额度照扣。
// 这是换用官方客户端的直接理由之一。
describe("中断能真的 abort 底层请求", () => {
  it("effect 被中断 → fetch 的 AbortSignal 被拉起", async () => {
    let signal: AbortSignal | undefined;
    const client = HttpClient.make((_request, _url, s) => {
      signal = s;
      // 永远不回 —— 只有中断能结束它。
      return Effect.never;
    });

    const exit = await Effect.gen(function* () {
      const fiber = yield* Effect.fork(req()("/v1/slow"));
      // 让请求真的发出去(stub 记下 signal)再中断。
      yield* Effect.yieldNow();
      yield* Effect.yieldNow();
      return yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.runPromise);

    expect(Exit.isInterrupted(exit)).toBe(true);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it("正常跑完不会误 abort", async () => {
    let signal: AbortSignal | undefined;
    const client = HttpClient.make((request, _url, s) => {
      signal = s;
      return Effect.succeed(HttpClientResponse.fromWeb(request, json({ ok: 1 })));
    });

    const out = await req()("/v1/t").pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.runPromise,
    );

    expect(out).toEqual({ ok: 1 });
    expect(signal?.aborted).toBe(false);
  });
});
