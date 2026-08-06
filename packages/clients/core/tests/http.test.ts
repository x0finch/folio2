import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { HttpFailure, SigningFailure } from "../src/errors";
import { Fetcher } from "../src/fetcher";
import { makeRequester } from "../src/http";

const BASE = "https://up.example.com";

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
    const req = makeRequester({ baseUrl: BASE });
    expect(await run(fn, req("/v1/thing"))).toEqual({ ok: 1 });
  });

  it("query 拼上,undefined 的键不参与", async () => {
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester({ baseUrl: BASE });
    await run(fn, req("/v1/t", { query: { a: 1, b: "x", c: undefined } }));
    expect(seen.url?.searchParams.get("a")).toBe("1");
    expect(seen.url?.searchParams.get("b")).toBe("x");
    expect(seen.url?.searchParams.has("c")).toBe(false);
  });

  it("fetch 抛 → network", async () => {
    const { fn } = stubFetch(() => {
      throw new Error("dns");
    });
    const req = makeRequester({ baseUrl: BASE });
    const err = await runFail(fn, req("/v1/t"));
    expect(err).toBeInstanceOf(HttpFailure);
    expect((err as HttpFailure).kind).toBe("network");
  });

  it("429 → rate-limited,Retry-After 秒数解析成毫秒", async () => {
    const { fn } = stubFetch(() => json({}, { status: 429, headers: { "retry-after": "3" } }));
    const req = makeRequester({ baseUrl: BASE });
    const err = (await runFail(fn, req("/v1/t"))) as HttpFailure;
    expect(err.kind).toBe("rate-limited");
    expect(err.retryAfterMs).toBe(3000);
  });

  it("Retry-After 是 HTTP-date 也认", async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const { fn } = stubFetch(() => json({}, { status: 429, headers: { "retry-after": at } }));
    const req = makeRequester({ baseUrl: BASE });
    const err = (await runFail(fn, req("/v1/t"))) as HttpFailure;
    // 秒级精度 + TestClock 未介入 → 给个宽窗口,别断言精确值。
    expect(err.retryAfterMs).toBeGreaterThan(3000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it("Retry-After 缺失 / 无效 → undefined", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "retry-after": "nonsense" },
      { "retry-after": "0" },
    ];
    for (const headers of cases) {
      const { fn } = stubFetch(() => json({}, { status: 429, headers }));
      const req = makeRequester({ baseUrl: BASE });
      const err = (await runFail(fn, req("/v1/t"))) as HttpFailure;
      expect(err.retryAfterMs).toBeUndefined();
    }
  });

  it("rateLimitedStatuses 可加(binance 要认 418)", async () => {
    const { fn } = stubFetch(() => json({}, { status: 418 }));
    const req = makeRequester({ baseUrl: BASE, rateLimitedStatuses: [429, 418] });
    expect(((await runFail(fn, req("/v1/t"))) as HttpFailure).kind).toBe("rate-limited");
  });

  it("401 / 403 → auth", async () => {
    for (const status of [401, 403]) {
      const { fn } = stubFetch(() => json({}, { status }));
      const req = makeRequester({ baseUrl: BASE });
      const err = (await runFail(fn, req("/v1/t"))) as HttpFailure;
      expect(err.kind).toBe("auth");
      expect(err.status).toBe(status);
    }
  });

  it("其余非 2xx → upstream", async () => {
    const { fn } = stubFetch(() => json({}, { status: 503 }));
    const req = makeRequester({ baseUrl: BASE });
    expect(((await runFail(fn, req("/v1/t"))) as HttpFailure).kind).toBe("upstream");
  });

  it("404 + notFoundAsNull → null(不是故障)", async () => {
    const { fn } = stubFetch(() => json({}, { status: 404 }));
    const req = makeRequester({ baseUrl: BASE });
    expect(await run(fn, req("/v1/t", { notFoundAsNull: true }))).toBeNull();
    // 不开这个开关时 404 仍是 upstream。
    expect(((await runFail(fn, req("/v1/t"))) as HttpFailure).kind).toBe("upstream");
  });

  it("回来的不是 JSON → parse", async () => {
    const { fn } = stubFetch(() => new Response("<html>", { status: 200 }));
    const req = makeRequester({ baseUrl: BASE });
    expect(((await runFail(fn, req("/v1/t"))) as HttpFailure).kind).toBe("parse");
  });

  it("失败信息只带 pathname,不带 query(原则 #5 红线)", async () => {
    const { fn } = stubFetch(() => json({}, { status: 503 }));
    const req = makeRequester({ baseUrl: BASE });
    const err = (await runFail(
      fn,
      req("/v1/t", { query: { address: "0xdeadbeef", signature: "s3cr3t" } }),
    )) as HttpFailure;
    expect(err.where).toBe("/v1/t");
    expect(JSON.stringify(err)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(err)).not.toContain("s3cr3t");
  });

  it("头算不出来 → SigningFailure,不被归类成传输故障", async () => {
    // 归错了会退化成「三次退避全白打」,还把真正的原因盖掉(rabby 的 wasm 签名靠这条)。
    const { fn } = stubFetch(() => json({}));
    const req = makeRequester({
      baseUrl: BASE,
      headers: () => Effect.fail(new SigningFailure({ where: "sig" })),
    });
    const err = await runFail(fn, req("/v1/t"));
    expect(err).toBeInstanceOf(SigningFailure);
    expect(err).not.toBeInstanceOf(HttpFailure);
  });

  it("头进得去,context 递给 headers()", async () => {
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester<string>({
      baseUrl: BASE,
      headers: (_path, options) => Effect.succeed({ "x-key": options?.context ?? "" }),
    });
    await run(fn, req("/v1/t", { context: "abc" }));
    expect((seen.init?.headers as Record<string, string>)["x-key"]).toBe("abc");
  });

  it("没配 headers() 时,调用方放在 init.headers 里的头不被抹掉", async () => {
    // 以前这里写死 `{ ...init, headers }`,headers 为 undefined 时把 init 里的头覆盖没了 ——
    // 静默丢头,发出去才发现上游回 422(hyperliquid 的 POST /info 就吃这个)。
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester({ baseUrl: BASE });
    await run(fn, req("/v1/t", { init: { headers: { "content-type": "application/json" } } }));
    expect((seen.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("配了 headers() 时它压过 init.headers(上游的头比单发的更权威)", async () => {
    const { fn, seen } = stubFetch(() => json({}));
    const req = makeRequester({
      baseUrl: BASE,
      headers: () => Effect.succeed({ "x-from": "config" }),
    });
    await run(fn, req("/v1/t", { init: { headers: { "x-from": "init" } } }));
    expect((seen.init?.headers as Record<string, string>)["x-from"]).toBe("config");
  });

  it("闸装上时每一发都过闸", async () => {
    let passes = 0;
    const { fn } = stubFetch(() => json({}));
    const req = makeRequester({
      baseUrl: BASE,
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
      const req = makeRequester({ baseUrl: BASE });
      expect(await Effect.runPromise(req("/v1/t"))).toEqual({ ok: 1 });
      expect(sawThis).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});
