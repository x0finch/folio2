import { defineRateLimit, MemorySlotStore } from "@folio/client-core";
import { Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { make } from "../src/client";
import {
  BINANCE_API_BASE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_FUTURES_API_BASE,
  EARN_PAGE_SIZE,
} from "../src/constants";
import type { BinanceError } from "../src/errors";
import { isRetryable } from "../src/errors";
import accountFixture from "./fixtures/account.json" with { type: "json" };
import coinmFixture from "./fixtures/coinm-account.json" with { type: "json" };
import fundingFixture from "./fixtures/funding-assets.json" with { type: "json" };
import futuresFixture from "./fixtures/futures-account.json" with { type: "json" };
import tickerFixture from "./fixtures/ticker-price.json" with { type: "json" };

const CREDS = { apiKey: "the-key", secret: "the-secret" } as const;

// 参考实现:**不调被测代码的 `hmacSha256`**,在测试里独立走一遍 WebCrypto。
// 要验的是「client 到底把哪一串拿去签了、signature 放在第几位」—— HMAC 算法本身由 WebCrypto 保证,
// 不是这里的被测对象。(不用 `node:crypto` 是为了不给 client 包引 `@types/node`:
// 仓里只有 `db` 与 `apps/web` 装了它,为一个断言拉进来不值。)
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

interface Seen {
  url: URL;
  init?: RequestInit;
}

// 假 fetch:记下每一发,按 pathname 回不同的 body。
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fn = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return Promise.resolve(reply(url));
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

// 闸单独给一份新 store —— 生产那个是模块级跨调用共享的,测试之间不能串。
const testGate = () =>
  defineRateLimit({ key: "t", limit: 6, interval: 15_000, store: new MemorySlotStore() });

const clientWith = (fn: typeof globalThis.fetch, over: Record<string, unknown> = {}) =>
  make({ fetch: fn, rateLimit: testGate(), ...over });

// TestClock 下 `Clock.currentTimeMillis` 从 0 起 —— 于是签名串是确定的,可以拿 node:crypto 对。
const run = <A>(eff: Effect.Effect<A, BinanceError>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(TestContext.TestContext)));

const runFail = (eff: Effect.Effect<unknown, BinanceError>): Promise<BinanceError> =>
  Effect.runPromise(Effect.flip(eff).pipe(Effect.provide(TestContext.TestContext)));

describe("签名", () => {
  it("签的是「除 signature 外、按发送顺序拼起来的 query」,signature 追加在最后", async () => {
    const { fn, calls } = stub(() => json(accountFixture));
    await run(clientWith(fn).spotAccount(CREDS));

    const sent = calls[0].url.searchParams;
    const signature = sent.get("signature");
    expect(signature).toBeTruthy();

    // 去掉 signature,保持原顺序重拼一遍 —— 这就是被签的那一串。
    const parts: string[] = [];
    sent.forEach((v, k) => {
      if (k !== "signature") parts.push(`${k}=${encodeURIComponent(v)}`);
    });
    const signable = parts.join("&");

    expect(signature).toBe(await hmacHex(CREDS.secret, signable));

    // signature 必须是最后一个参数(binance 按发送顺序验)。
    expect([...sent.keys()].at(-1)).toBe("signature");
    // TestClock 下 timestamp 确定 → 这串就是它。
    expect(signable).toBe("recvWindow=5000&timestamp=0");
  });

  it("apiKey 走 header 而不是 query(它是标识符,不是签名材料)", async () => {
    const { fn, calls } = stub(() => json(accountFixture));
    await run(clientWith(fn).spotAccount(CREDS));
    expect((calls[0].init?.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(CREDS.apiKey);
    expect(calls[0].url.searchParams.has("apiKey")).toBe(false);
    expect(calls[0].url.searchParams.has("secret")).toBe(false);
  });
});

describe("端点打对 host / 路径 / method", () => {
  it("现货、U 本位、币本位各打自己的 host", async () => {
    const { fn, calls } = stub((url) =>
      json(url.pathname.includes("dapi") ? coinmFixture : futuresFixture),
    );
    const c = clientWith(fn);
    await run(c.spotAccount(CREDS));
    await run(c.usdmAccount(CREDS));
    await run(c.coinmAccount(CREDS));
    expect(calls[0].url.origin).toBe(BINANCE_API_BASE);
    expect(calls[0].url.pathname).toBe("/api/v3/account");
    expect(calls[1].url.origin).toBe(BINANCE_FUTURES_API_BASE);
    expect(calls[1].url.pathname).toBe("/fapi/v2/account");
    expect(calls[2].url.origin).toBe(BINANCE_DELIVERY_API_BASE);
    expect(calls[2].url.pathname).toBe("/dapi/v1/account");
  });

  it("资金账户是 POST(参数仍走 query)", async () => {
    const { fn, calls } = stub(() => json(fundingFixture));
    await run(clientWith(fn).fundingAssets(CREDS));
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/sapi/v1/asset/get-funding-asset");
    expect(calls[0].url.searchParams.has("signature")).toBe(true);
  });

  it("三个 base 可各自覆盖,且当不透明整串用(代理 #264)", async () => {
    const { fn, calls } = stub(() => json(futuresFixture));
    const c = clientWith(fn, {
      apiBase: "http://localhost:3099",
      fapiBase: "http://localhost:3098/fapi-proxy",
      dapiBase: "http://localhost:3097",
    });
    await run(c.spotAccount(CREDS));
    await run(c.usdmAccount(CREDS));
    expect(calls[0].url.origin).toBe("http://localhost:3099");
    // 覆盖串里带路径前缀也照用 —— client 不解析它。
    expect(calls[1].url.href).toContain("/fapi-proxy/fapi/v2/account");
  });
});

describe("tickerPrices", () => {
  it("数组翻成 symbol → price 的表", async () => {
    const { fn } = stub(() => json(tickerFixture));
    const table = await run(clientWith(fn).tickerPrices);
    // 上游给的是字符串价 —— 表里要是数字。
    expect(table.BTCUSDT).toBe(60000);
    expect(table.ETHUSDT).toBe(3000);
    expect(Object.keys(table)).toHaveLength(tickerFixture.length);
  });

  it("免签:不带 signature、不带 apiKey 头", async () => {
    const { fn, calls } = stub(() => json(tickerFixture));
    await run(clientWith(fn).tickerPrices);
    expect(calls[0].url.searchParams.has("signature")).toBe(false);
    expect(calls[0].init?.headers).toBeUndefined();
  });
});

describe("翻页(理财)", () => {
  const rowsOf = (n: number, asset = "BTC") =>
    Array.from({ length: n }, () => ({ asset, totalAmount: "1" }));

  it("末页(不足一页)即停", async () => {
    const { fn, calls } = stub(() => json({ rows: rowsOf(3) }));
    const rows = await run(clientWith(fn).earnFlexible(CREDS));
    expect(rows).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it("满页则继续翻,收全", async () => {
    let page = 0;
    const { fn, calls } = stub(() => {
      page++;
      return json({ rows: page === 1 ? rowsOf(EARN_PAGE_SIZE) : rowsOf(7) });
    });
    const rows = await run(clientWith(fn).earnFlexible(CREDS));
    expect(rows).toHaveLength(EARN_PAGE_SIZE + 7);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("current")).toBe("1");
    expect(calls[1].url.searchParams.get("current")).toBe("2");
    expect(calls[0].url.searchParams.get("size")).toBe(String(EARN_PAGE_SIZE));
  });

  it("收满 total 即停(哪怕这一页是满的)", async () => {
    const { fn, calls } = stub(() => json({ rows: rowsOf(EARN_PAGE_SIZE), total: EARN_PAGE_SIZE }));
    const rows = await run(clientWith(fn).earnFlexible(CREDS));
    expect(rows).toHaveLength(EARN_PAGE_SIZE);
    expect(calls).toHaveLength(1);
  });

  it("页数上限护栏兜住不肯结束的上游", async () => {
    // 每页都满、total 撒谎说 0 —— 没有护栏就是死循环。
    const { fn, calls } = stub(() => json({ rows: rowsOf(EARN_PAGE_SIZE), total: 0 }));
    const rows = await run(clientWith(fn).earnFlexible(CREDS));
    expect(calls).toHaveLength(50); // EARN_MAX_PAGES
    expect(rows).toHaveLength(50 * EARN_PAGE_SIZE);
  });

  it("活期与定期各打自己的端点", async () => {
    const { fn, calls } = stub(() => json({ rows: [] }));
    const c = clientWith(fn);
    await run(c.earnFlexible(CREDS));
    await run(c.earnLocked(CREDS));
    expect(calls[0].url.pathname).toBe("/sapi/v1/simple-earn/flexible/position");
    expect(calls[1].url.pathname).toBe("/sapi/v1/simple-earn/locked/position");
  });
});

describe("错误归类", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ code: -1022, msg: "signature invalid" }, init));
    return runFail(clientWith(fn).spotAccount(CREDS));
  };

  it("400 → 凭据问题且不可重试(binance 用 400 表达签名请求被拒)", async () => {
    const err = await failWith({ status: 400 });
    expect(err._tag).toBe("BinanceAuthError");
    // 重试没用,还会拿错凭据再打一次 —— binance 把重复认证失败当探测行为(#240)。
    expect(isRetryable(err)).toBe(false);
  });

  it("401 / 403 → 凭据问题", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("BinanceAuthError");
    }
  });

  it("429 与 418 同类,且带上 Retry-After", async () => {
    for (const status of [429, 418]) {
      const err = await failWith({ status, headers: { "retry-after": "7" } });
      expect(err._tag).toBe("BinanceRateLimitError");
      expect(isRetryable(err)).toBe(true);
      expect(err._tag === "BinanceRateLimitError" && err.retryAfterMs).toBe(7000);
    }
  });

  it("5xx → upstream,可重试", async () => {
    const err = await failWith({ status: 503 });
    expect(err._tag).toBe("BinanceUpstreamError");
    expect(isRetryable(err)).toBe(true);
  });

  it("读不成 JSON → parse,不可重试", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    const err = await runFail(clientWith(fn).spotAccount(CREDS));
    expect(err._tag).toBe("BinanceParseError");
    expect(isRetryable(err)).toBe(false);
  });

  it("出不去 → upstream,可重试", async () => {
    const { fn } = stub(() => {
      throw new Error("dns");
    });
    const err = await runFail(clientWith(fn).spotAccount(CREDS));
    expect(err._tag).toBe("BinanceUpstreamError");
    expect(isRetryable(err)).toBe(true);
  });

  it("失败信息不带 query(签名/凭据在里面,原则 #5 红线)", async () => {
    const err = await failWith({ status: 503 });
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.apiKey);
    expect(dump).not.toContain("signature=");
  });
});

describe("限频", () => {
  it("公开端点带闸:超出突发的那一发要等", async () => {
    // 闸 6 发 / 15s → 间距 2500ms,突发 12500ms。第 7 发落在下一个间距上。
    const seven = () => {
      const { fn } = stub(() => json(tickerFixture));
      const c = make({ fetch: fn, rateLimit: testGate() });
      return Effect.all(Array.from({ length: 7 }, () => c.tickerPrices));
    };
    const settled = (ms: number) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(seven());
        yield* TestClock.adjust(Duration.millis(ms));
        return Option.isSome(yield* Fiber.poll(fiber));
      }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);

    expect(await settled(2499)).toBe(false);
    expect(await settled(2500)).toBe(true);
  });

  it("签名端点不带闸:连发多少都不等", async () => {
    // 每账户一发、不并发 —— 装闸拦不到东西,还会把互不相干的账户排成一队白等。
    const { fn } = stub(() => json(accountFixture));
    const c = clientWith(fn);
    const ten = Effect.all(Array.from({ length: 10 }, () => c.spotAccount(CREDS)));
    const done = await Effect.gen(function* () {
      const fiber = yield* Effect.fork(ten);
      yield* TestClock.adjust(Duration.zero);
      return Option.isSome(yield* Fiber.poll(fiber));
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
    expect(done).toBe(true);
  });
});
