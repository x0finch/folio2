import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SigningFailure } from "../src/errors";
import { Fetcher } from "../src/fetcher";
import { makeRequester } from "../src/http";
import { UpstreamAuthError } from "../src/upstream-error";

const BASE = "https://up.example.com";
const UPSTREAM = "acme";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

// 记下最后一次 fetch 到的 URL,给「query 拼对了吗」这类断言用。
function stubFetch(reply: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const seen: { url?: URL; init?: RequestInit } = {};
  const fn = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    seen.url = url;
    seen.init = init;
    return Promise.resolve(reply(url, init));
  }) as typeof globalThis.fetch;
  return { fn, seen };
}

// 出网替换走**可选服务**,不是构造器参数 —— 与 `SlotCacheOverride` 同一套。
const run = <A, E>(fetch: typeof globalThis.fetch, eff: Effect.Effect<A, E, Fetcher>) =>
  Effect.runPromise(Effect.provideService(eff, Fetcher, fetch));

const runFail = <A, E>(
  fetch: typeof globalThis.fetch,
  eff: Effect.Effect<A, E, Fetcher>,
): Promise<E> => run(fetch, Effect.flip(eff));

describe("makeRequester", () => {
  it("2xx → 解析好的 JSON", async () => {
    const { fn } = stubFetch(() => json({ ok: 1 }));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    expect(await run(fn, req("/v1/thing"))).toEqual({ ok: 1 });
  });

  it("query 拼上,undefined 的键不参与", async () => {
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    await run(fn, req("/v1/t", { query: { a: 1, b: "x", c: undefined } }));
    expect(seen.url?.searchParams.get("a")).toBe("1");
    expect(seen.url?.searchParams.get("b")).toBe("x");
    expect(seen.url?.searchParams.has("c")).toBe(false);
  });

  it("fetch 抛 → network", async () => {
    const { fn } = stubFetch(() => {
      throw new Error("dns");
    });
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    const err = await runFail(fn, req("/v1/t"));
    // 出口就是最终错误面 —— 不再是 `HttpFailure` 那个中间态。
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(err.upstream).toBe(UPSTREAM);
  });

  it("429 → rate-limited,Retry-After 秒数解析成毫秒", async () => {
    const { fn } = stubFetch(() => json({}, { status: 429, headers: { "retry-after": "3" } }));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    const err = await runFail(fn, req("/v1/t"));
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(3000);
  });

  it("Retry-After 是 HTTP-date 也认", async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const { fn } = stubFetch(() => json({}, { status: 429, headers: { "retry-after": at } }));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    const err = await runFail(fn, req("/v1/t"));
    // 秒级精度 + TestClock 未介入 → 给个宽窗口,别断言精确值。
    const ms = err._tag === "UpstreamRateLimitError" ? err.retryAfterMs : undefined;
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("Retry-After 缺失 / 无效 → undefined", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "retry-after": "nonsense" },
      { "retry-after": "0" },
    ];
    for (const headers of cases) {
      const { fn } = stubFetch(() => json({}, { status: 429, headers }));
      const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
      const err = await runFail(fn, req("/v1/t"));
      expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBeUndefined();
    }
  });

  it("rateLimitedStatuses 可加(binance 要认 418)", async () => {
    const { fn } = stubFetch(() => json({}, { status: 418 }));
    const req = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      rateLimitedStatuses: [429, 418],
    });
    expect((await runFail(fn, req("/v1/t")))._tag).toBe("UpstreamRateLimitError");
  });

  it("401 / 403 → auth", async () => {
    for (const status of [401, 403]) {
      const { fn } = stubFetch(() => json({}, { status }));
      const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
      const err = await runFail(fn, req("/v1/t"));
      expect(err._tag).toBe("UpstreamAuthError");
      expect(err.status).toBe(status);
    }
  });

  it("其余非 2xx → upstream", async () => {
    const { fn } = stubFetch(() => json({}, { status: 503 }));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    expect((await runFail(fn, req("/v1/t")))._tag).toBe("UpstreamUnavailableError");
  });

  it("404 + notFoundAsNull → null(不是故障)", async () => {
    const { fn } = stubFetch(() => json({}, { status: 404 }));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    expect(await run(fn, req("/v1/t", { notFoundAsNull: true }))).toBeNull();
    // 不开这个开关时 404 仍是 upstream。
    expect((await runFail(fn, req("/v1/t")))._tag).toBe("UpstreamUnavailableError");
  });

  it("回来的不是 JSON → parse", async () => {
    const { fn } = stubFetch(() => new Response("<html>", { status: 200 }));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    expect((await runFail(fn, req("/v1/t")))._tag).toBe("UpstreamParseError");
  });

  it("失败信息只带 pathname,不带 query(原则 #5 红线)", async () => {
    const { fn } = stubFetch(() => json({}, { status: 503 }));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    const err = await runFail(
      fn,
      req("/v1/t", { query: { address: "0xdeadbeef", signature: "s3cr3t" } }),
    );
    expect(err.where).toBe("/v1/t");
    expect(JSON.stringify(err)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(err)).not.toContain("s3cr3t");
  });

  it("头算不出来 → SigningFailure,不被归类成传输故障", async () => {
    // 归错了会退化成「三次退避全白打」,还把真正的原因盖掉(rabby 的 wasm 签名靠这条)。
    const { fn } = stubFetch(() => json({}));
    const req = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: () => Effect.fail(new SigningFailure({ where: "sig" })),
    });
    // 签不出来仍然走「凭据问题」而不是传输故障 —— 归类在包里做完,出口只有一种错误面。
    const err = await runFail(fn, req("/v1/t"));
    expect(err._tag).toBe("UpstreamAuthError");
  });

  it("头进得去,context 递给 headers()", async () => {
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester<string>({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: (_path, options) => Effect.succeed({ "x-key": options?.context ?? "" }),
    });
    await run(fn, req("/v1/t", { context: "abc" }));
    expect((seen.init?.headers as Record<string, string>)["x-key"]).toBe("abc");
  });

  it("没配 headers() 时,调用方放在 init.headers 里的头不被抹掉", async () => {
    // 以前这里写死 `{ ...init, headers }`,headers 为 undefined 时把 init 里的头覆盖没了 ——
    // 静默丢头,发出去才发现上游回 422(hyperliquid 的 POST /info 就吃这个)。
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
    await run(fn, req("/v1/t", { init: { headers: { "content-type": "application/json" } } }));
    expect((seen.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("配了 headers() 时它压过 init.headers(上游的头比单发的更权威)", async () => {
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      headers: () => Effect.succeed({ "x-from": "config" }),
    });
    await run(fn, req("/v1/t", { init: { headers: { "x-from": "init" } } }));
    expect((seen.init?.headers as Record<string, string>)["x-from"]).toBe("config");
  });

  it("checkBody:HTTP 200 但 body 里说不行 → 失败", async () => {
    // CEX 常见形状(bybit 的 retCode、okx 的 code)。放在这一层,「一发请求算不算成功」
    // 就只有一个答案,不必每个 client 各写一个包装去 flatMap 一遍。
    const { fn } = stubFetch(() => json({ retCode: 10004, retMsg: "sign check error" }));
    const req = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      checkBody: (body, where) =>
        (body as { retCode?: number }).retCode === 0
          ? undefined
          : new UpstreamAuthError({ upstream: UPSTREAM, where, cause: "bad code" }),
    });
    const err = await runFail(fn, req("/v1/t"));
    expect(err._tag).toBe("UpstreamAuthError");
    // where 是 pathname,不是入参 path —— 后者可能带 query(原则 #5 红线)。
    expect(err.where).toBe("/v1/t");
  });

  it("checkBody 不跑在 notFoundAsNull 的 null 上", async () => {
    // 那个 null 是「没有这个东西」的正常答案,不是一份 body。喂给读 `body.retCode` 的实现
    // 会当场 TypeError —— 而且是 defect(不进错误通道),排查起来毫无线索。
    const { fn } = stubFetch(() => json({}, { status: 404 }));
    let calls = 0;
    const req = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      checkBody: (body) => {
        calls++;
        // 真实实现就长这样 —— body 是 null 的话这一行就炸。
        return (body as { retCode?: number }).retCode === 0 ? undefined : undefined;
      },
    });
    expect(await run(fn, req("/v1/t", { notFoundAsNull: true }))).toBeNull();
    expect(calls).toBe(0);
  });

  it("classifyOverride:上游特有的传输层归类差异压过默认规则", async () => {
    // binance 用 HTTP 400 表达「这份签名请求被拒」—— 默认规则会当成上游的锅去重试它。
    const { fn } = stubFetch(() => json({}, { status: 400 }));
    const req = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      classifyOverride: (f) =>
        f.status === 400
          ? new UpstreamAuthError({ upstream: UPSTREAM, where: f.where, status: f.status })
          : undefined,
    });
    expect((await runFail(fn, req("/v1/t")))._tag).toBe("UpstreamAuthError");

    // 没命中 override 的照默认走。
    const { fn: down } = stubFetch(() => json({}, { status: 503 }));
    expect((await runFail(down, req("/v1/t")))._tag).toBe("UpstreamUnavailableError");
  });

  it("闸装上时每一发都过闸", async () => {
    let passes = 0;
    const { fn } = stubFetch(() => json({}));
    const req = makeRequester({
      baseUrl: BASE,
      upstream: UPSTREAM,
      limit: Object.assign(
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
      ),
    });
    await run(fn, Effect.all([req("/a"), req("/b")]));
    expect(passes).toBe(2);
  });

  it("不 provide Fetcher → 回退到全局 fetch,且 this 没丢", async () => {
    // 这条钉的是 `globalThis.fetch.bind(globalThis)`:在 CF Workers 上把 fetch 存进变量再调
    // 会丢 this,出网静默失败。以前只有一行注释说这事,没有测试。
    const original = globalThis.fetch;
    let sawThis: unknown = "never-called";
    globalThis.fetch = function (this: unknown) {
      sawThis = this;
      return Promise.resolve(json({ ok: 1 }));
    } as typeof globalThis.fetch;
    try {
      const req = makeRequester({ baseUrl: BASE, upstream: UPSTREAM });
      expect(await Effect.runPromise(req("/v1/t"))).toEqual({ ok: 1 });
      expect(sawThis).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});
