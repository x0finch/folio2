import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpClient, defineRateLimit, resetRateLimitsForTests } from "../src/index";
import type { Failure } from "../src/types";

// 这个包装还**没有接进任何调用点**(等确认后再逐个替换),所以它的行为只由这个文件钉着。
// 它要替掉的是五个 provider 里几乎一样的 `ensureOk` 和仓库里三份 `parseRetryAfter`,
// 所以这里逐条对着那些行为测:五种归类、Retry-After、404 当空、限频与重试的组合。

// 假的错误类型:字段名跟仓库里那四个错误类一致(retryable / retryAfterMs),
// 于是 withRetry 的鸭子类型判据认得它 —— 这也是对调用方的要求。
class FakeError extends Error {
  constructor(
    readonly failure: Failure,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(`${failure.kind} @ ${failure.where}`);
  }
}

const BASE = "https://api.test";

const toFailure = (f: Failure): Error =>
  new FakeError(
    f,
    f.kind === "rate-limited" || f.kind === "network" || (f.status ?? 0) >= 500,
    f.retryAfterMs,
  );

function stubFetch(steps: Array<Partial<Response> | Error>) {
  let i = 0;
  const seen: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(input));
    inits.push(init);
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, seen, inits };
}

const ok = (body: unknown): Partial<Response> => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: new Headers(),
});
const status = (code: number, headers?: Record<string, string>): Partial<Response> => ({
  ok: false,
  status: code,
  headers: new Headers(headers),
});

const grab = async (p: Promise<unknown>): Promise<FakeError> => {
  try {
    await p;
    throw new Error("expected to throw");
  } catch (e) {
    return e as FakeError;
  }
};

beforeEach(() => resetRateLimitsForTests());
afterEach(() => vi.unstubAllGlobals());

describe("URL 与头", () => {
  it("baseUrl + path + query 拼起来,undefined 的键不参与", async () => {
    const { seen } = stubFetch([ok({})]);
    const get = createHttpClient({ baseUrl: "https://api.test/v1", toFailure });
    await get("/coins", { query: { id: "btc", page: 2, skip: undefined } });
    const url = new URL(seen[0]);
    expect(url.pathname).toBe("/v1/coins");
    expect(url.searchParams.get("id")).toBe("btc");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("skip")).toBe(false);
  });

  it("头是函数,而且拿得到 path 和 options —— 签名类的头要按它们算", async () => {
    const { inits } = stubFetch([ok({})]);
    const seenArgs: Array<unknown[]> = [];
    const get = createHttpClient({
      baseUrl: BASE,
      toFailure,
      headers: async (path, options) => {
        seenArgs.push([path, options?.query]);
        return { "x-sig": `signed:${path}` };
      },
    });
    await get("/balance", { query: { addr: "0xabc" } });
    expect(seenArgs).toEqual([["/balance", { addr: "0xabc" }]]);
    expect(inits[0]?.headers).toEqual({ "x-sig": "signed:/balance" });
  });
});

describe("头的异常不归类", () => {
  it("headers() 抛的错原样抛出,不被当成 network —— rabby 的签名失败靠这条", async () => {
    stubFetch([ok({})]);
    class SigningError extends Error {}
    const get = createHttpClient({
      baseUrl: BASE,
      toFailure,
      headers: () => {
        throw new SigningError("wasm gone");
      },
    });
    const err = await get("/x").catch((e) => e);
    expect(err).toBeInstanceOf(SigningError); // 不是 FakeError
  });
});

describe("失败归类", () => {
  it("fetch 抛了 → network", async () => {
    stubFetch([new Error("dns down")]);
    const err = await grab(createHttpClient({ baseUrl: BASE, toFailure })("/x"));
    expect(err.failure.kind).toBe("network");
    expect(err.failure.cause).toBeInstanceOf(Error);
  });

  it("429 → rate-limited,并解析 Retry-After 的秒数", async () => {
    stubFetch([status(429, { "retry-after": "30" })]);
    const err = await grab(createHttpClient({ baseUrl: BASE, toFailure })("/x"));
    expect(err.failure.kind).toBe("rate-limited");
    expect(err.failure.retryAfterMs).toBe(30_000);
  });

  it("Retry-After 是 HTTP-date 也认", async () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    stubFetch([status(429, { "retry-after": when })]);
    const err = await grab(createHttpClient({ baseUrl: BASE, toFailure })("/x"));
    expect(err.failure.retryAfterMs).toBeGreaterThan(3000);
    expect(err.failure.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it("Retry-After 缺失或是垃圾 → retryAfterMs 为 undefined,而不是 NaN", async () => {
    stubFetch([status(429), status(429, { "retry-after": "later" })]);
    const get = createHttpClient({ baseUrl: BASE, toFailure });
    expect((await grab(get("/x"))).failure.retryAfterMs).toBeUndefined();
    expect((await grab(get("/y"))).failure.retryAfterMs).toBeUndefined();
  });

  it("rateLimitedStatuses 可配 —— binance 的 418 也算限流", async () => {
    stubFetch([status(418)]);
    const get = createHttpClient({ baseUrl: BASE, toFailure, rateLimitedStatuses: [429, 418] });
    expect((await grab(get("/x"))).failure.kind).toBe("rate-limited");
  });

  it("默认不认 418(不给它加隐式行为)", async () => {
    stubFetch([status(418)]);
    expect((await grab(createHttpClient({ baseUrl: BASE, toFailure })("/x"))).failure.kind).toBe(
      "upstream",
    );
  });

  it("401 / 403 → auth", async () => {
    stubFetch([status(401), status(403)]);
    const get = createHttpClient({ baseUrl: BASE, toFailure });
    expect((await grab(get("/x"))).failure.kind).toBe("auth");
    expect((await grab(get("/y"))).failure.kind).toBe("auth");
  });

  it("其余非 2xx → upstream,并带上状态码给调用方判 retryable", async () => {
    stubFetch([status(503)]);
    const err = await grab(createHttpClient({ baseUrl: BASE, toFailure })("/x"));
    expect(err.failure.kind).toBe("upstream");
    expect(err.failure.status).toBe(503);
    expect(err.retryable).toBe(true); // 由 toFailure 按状态码决定,不是包决定的
  });

  it("2xx 但读不成 JSON → parse", async () => {
    stubFetch([
      {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error("bad json");
        },
      },
    ]);
    expect((await grab(createHttpClient({ baseUrl: BASE, toFailure })("/x"))).failure.kind).toBe(
      "parse",
    );
  });

  it("失败信息里**只有 pathname,没有 query** —— query 里有地址和签名", async () => {
    stubFetch([status(500)]);
    const get = createHttpClient({ baseUrl: "https://api.test", toFailure });
    const err = await grab(get("/wallet", { query: { address: "0xSECRET", sig: "SECRET" } }));
    expect(err.failure.where).toBe("/wallet");
    expect(JSON.stringify(err.failure)).not.toContain("SECRET");
    expect(err.message).not.toContain("SECRET");
  });
});

describe("404", () => {
  it("notFoundAsNull → 返回 null,不当故障", async () => {
    stubFetch([status(404)]);
    expect(
      await createHttpClient({ baseUrl: BASE, toFailure })("/x", { notFoundAsNull: true }),
    ).toBeNull();
  });

  it("没开这个开关 → 404 仍是 upstream 故障", async () => {
    stubFetch([status(404)]);
    expect((await grab(createHttpClient({ baseUrl: BASE, toFailure })("/x"))).failure.kind).toBe(
      "upstream",
    );
  });
});

describe("限频与重试的组合", () => {
  it("不传 limit / retry → 就是一次干净的 fetch", async () => {
    const { fn } = stubFetch([ok({ a: 1 })]);
    expect(await createHttpClient({ baseUrl: BASE, toFailure })("/x")).toEqual({ a: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("429 之后重试并成功", async () => {
    const { fn } = stubFetch([status(429, { "retry-after": "1" }), ok({ a: 1 })]);
    const get = createHttpClient({
      baseUrl: BASE,
      toFailure,
      retry: { attempts: 2, maxWaitMs: 5000, baseMs: 1, sleep: async () => {} },
    });
    expect(await get("/x")).toEqual({ a: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("不可重试的失败(auth)一次都不重试", async () => {
    const { fn } = stubFetch([status(401)]);
    const get = createHttpClient({
      baseUrl: BASE,
      toFailure,
      retry: { attempts: 3, maxWaitMs: 5000, baseMs: 1, sleep: async () => {} },
    });
    await grab(get("/x"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("**闸在重试里面** —— 重试也要排队,不能退避完就插队", async () => {
    const { fn } = stubFetch([status(429, { "retry-after": "1" }), ok({})]);
    const waits: number[] = [];
    const get = createHttpClient({
      baseUrl: BASE,
      toFailure,
      limit: defineRateLimit({
        key: "http-test",
        limit: 1,
        interval: 100,
        store: "memory",
        clock: () => 0,
        sleep: async (ms) => void waits.push(ms),
      }),
      retry: { attempts: 2, maxWaitMs: 5000, baseMs: 1, sleep: async () => {} },
    });
    await get("/x");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([100]); // 第二次(重试那次)也过了闸,被要求等一个间距
  });

  it("多个请求过同一个闸 → 被摊开", async () => {
    stubFetch([ok({})]);
    const waits: number[] = [];
    const get = createHttpClient({
      baseUrl: BASE,
      toFailure,
      limit: defineRateLimit({
        key: "http-spread",
        limit: 2,
        interval: 100,
        store: "memory",
        clock: () => 0,
        sleep: async (ms) => void waits.push(ms),
      }),
    });
    await Promise.all([get("/a"), get("/b"), get("/c"), get("/d")]);
    expect(waits).toEqual([50, 100]); // 头两发不等,后两发依次错开半个间距
  });
});
