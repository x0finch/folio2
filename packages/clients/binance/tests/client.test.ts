import { Fetcher, type UpstreamError } from "@folio/client-core";
import { Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { type BinanceClientApi, type BinanceConfig, make } from "../src/client";
import {
  BINANCE_API_BASE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_FUTURES_API_BASE,
  EARN_PAGE_SIZE,
} from "../src/constants";
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

// client 的构造本身是 Effect(闸要 Scope),所以每个 case 在一个 scope 里建了用、用完就扔。
//
// **闸一律用 `memory` 档** —— 那是 Effect 官方实现,桶绑在 scope 上、每次 make 一份,天然隔离。
// 生产走 `isolated`(跨 isolate 共享游标),它的算法行为在 `@folio/client-core` 的测试里验;
// 这里只验**结构**:哪些端点过闸、哪些刻意不过。
//
// TestClock 下 `Clock.currentTimeMillis` 从 0 起 —— 于是签名串是确定的,可以拿参考实现对。
const withClient = <A, E>(
  fn: typeof globalThis.fetch,
  use: (client: BinanceClientApi) => Effect.Effect<A, E>,
  over: Partial<BinanceConfig> = {},
): Promise<A> =>
  Effect.gen(function* () {
    const client = yield* make({ rateLimitScope: "memory", ...over });
    return yield* use(client);
  }).pipe(
    Effect.scoped,
    Effect.provideService(Fetcher, fn), // 出网替换是**服务**,不是 config 上的字段
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );

// 拿失败:同上,但翻到成功通道。
const failing = (
  fn: typeof globalThis.fetch,
  use: (client: BinanceClientApi) => Effect.Effect<unknown, UpstreamError>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

describe("签名", () => {
  it("签的是「除 signature 外、按发送顺序拼起来的 query」,signature 追加在最后", async () => {
    const { fn, calls } = stub(() => json(accountFixture));
    await withClient(fn, (c) => c.spotAccount(CREDS));

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
    await withClient(fn, (c) => c.spotAccount(CREDS));
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
    await withClient(fn, (c) =>
      Effect.all([c.spotAccount(CREDS), c.usdmAccount(CREDS), c.coinmAccount(CREDS)]),
    );
    expect(calls[0].url.origin).toBe(BINANCE_API_BASE);
    expect(calls[0].url.pathname).toBe("/api/v3/account");
    expect(calls[1].url.origin).toBe(BINANCE_FUTURES_API_BASE);
    expect(calls[1].url.pathname).toBe("/fapi/v2/account");
    expect(calls[2].url.origin).toBe(BINANCE_DELIVERY_API_BASE);
    expect(calls[2].url.pathname).toBe("/dapi/v1/account");
  });

  it("资金账户是 POST(参数仍走 query)", async () => {
    const { fn, calls } = stub(() => json(fundingFixture));
    await withClient(fn, (c) => c.fundingAssets(CREDS));
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/sapi/v1/asset/get-funding-asset");
    expect(calls[0].url.searchParams.has("signature")).toBe(true);
  });

  it("三个 base 可各自覆盖,且当不透明整串用(代理 #264)", async () => {
    const { fn, calls } = stub(() => json(futuresFixture));
    await withClient(fn, (c) => Effect.all([c.spotAccount(CREDS), c.usdmAccount(CREDS)]), {
      apiBase: "http://localhost:3099",
      fapiBase: "http://localhost:3098/fapi-proxy",
      dapiBase: "http://localhost:3097",
    });
    expect(calls[0].url.origin).toBe("http://localhost:3099");
    // 覆盖串里带路径前缀也照用 —— client 不解析它。
    expect(calls[1].url.href).toContain("/fapi-proxy/fapi/v2/account");
  });
});

describe("tickerPrices", () => {
  it("数组翻成 symbol → price 的表", async () => {
    const { fn } = stub(() => json(tickerFixture));
    const table = await withClient(fn, (c) => c.tickerPrices);
    // 上游给的是字符串价 —— 表里要是数字。
    expect(table.BTCUSDT).toBe(60000);
    expect(table.ETHUSDT).toBe(3000);
    expect(Object.keys(table)).toHaveLength(tickerFixture.length);
  });

  it("免签:不带 signature、不带 apiKey 头", async () => {
    const { fn, calls } = stub(() => json(tickerFixture));
    await withClient(fn, (c) => c.tickerPrices);
    expect(calls[0].url.searchParams.has("signature")).toBe(false);
    expect(calls[0].init?.headers).toBeUndefined();
  });
});

describe("翻页(理财)", () => {
  const rowsOf = (n: number, asset = "BTC") =>
    Array.from({ length: n }, () => ({ asset, totalAmount: "1" }));

  it("末页(不足一页)即停", async () => {
    const { fn, calls } = stub(() => json({ rows: rowsOf(3) }));
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(rows).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it("满页则继续翻,收全", async () => {
    let page = 0;
    const { fn, calls } = stub(() => {
      page++;
      return json({ rows: page === 1 ? rowsOf(EARN_PAGE_SIZE) : rowsOf(7) });
    });
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(rows).toHaveLength(EARN_PAGE_SIZE + 7);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("current")).toBe("1");
    expect(calls[1].url.searchParams.get("current")).toBe("2");
    expect(calls[0].url.searchParams.get("size")).toBe(String(EARN_PAGE_SIZE));
  });

  it("收满 total 即停(哪怕这一页是满的)", async () => {
    const { fn, calls } = stub(() => json({ rows: rowsOf(EARN_PAGE_SIZE), total: EARN_PAGE_SIZE }));
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(rows).toHaveLength(EARN_PAGE_SIZE);
    expect(calls).toHaveLength(1);
  });

  it("页数上限护栏兜住不肯结束的上游", async () => {
    // 每页都满、total 撒谎说 0 —— 没有护栏就是死循环。
    const { fn, calls } = stub(() => json({ rows: rowsOf(EARN_PAGE_SIZE), total: 0 }));
    const rows = await withClient(fn, (c) => c.earnFlexible(CREDS));
    expect(calls).toHaveLength(50); // EARN_MAX_PAGES
    expect(rows).toHaveLength(50 * EARN_PAGE_SIZE);
  });

  it("活期与定期各打自己的端点", async () => {
    const { fn, calls } = stub(() => json({ rows: [] }));
    await withClient(fn, (c) => Effect.all([c.earnFlexible(CREDS), c.earnLocked(CREDS)]));
    expect(calls[0].url.pathname).toBe("/sapi/v1/simple-earn/flexible/position");
    expect(calls[1].url.pathname).toBe("/sapi/v1/simple-earn/locked/position");
  });
});

describe("错误归类", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ code: -1022, msg: "signature invalid" }, init));
    return failing(fn, (c) => c.spotAccount(CREDS));
  };

  // **这条是 binance 唯一的归类差异**(它的 `override`):默认规则会把 400 归成「上游的锅」而去
  // 重试它 —— 重试没用,还会拿错凭据再打一次,binance 把重复认证失败当探测行为(#240)。
  // 其余几条验的是默认规则在这条链路上确实通了;规则本身在 `@folio/client-core` 的测试里。
  it("400 → 凭据问题(binance 用 400 表达签名请求被拒)", async () => {
    expect((await failWith({ status: 400 }))._tag).toBe("UpstreamAuthError");
  });

  it("401 / 403 → 凭据问题", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 与 418 同类,且带上 Retry-After", async () => {
    for (const status of [429, 418]) {
      const err = await failWith({ status, headers: { "retry-after": "7" } });
      expect(err._tag).toBe("UpstreamRateLimitError");
      expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(7000);
    }
  });

  it("5xx → 够不到上游", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("读不成 JSON → parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.spotAccount(CREDS)))._tag).toBe("UpstreamParseError");
  });

  it("出不去 → 够不到上游", async () => {
    const { fn } = stub(() => {
      throw new Error("dns");
    });
    expect((await failing(fn, (c) => c.spotAccount(CREDS)))._tag).toBe("UpstreamUnavailableError");
  });

  it("失败信息不带 query(签名/凭据在里面,原则 #5 红线)", async () => {
    const err = await failWith({ status: 503 });
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.apiKey);
    expect(dump).not.toContain("signature=");
  });
});

describe("限频:哪些端点过闸", () => {
  // **这里验的是结构,不是算法。** 闸本身(GCRA / 跨 isolate 游标)的行为在 `@folio/client-core`
  // 的测试里;这两条只回答「公开端点过闸了吗、签名端点是不是刻意没过」。
  //
  // 用 `memory` 档 = Effect 官方 token-bucket:limit 6 / 15s → 每 2500ms 补一个令牌,
  // 前 6 发满额突发、第 7 发等一个令牌。
  const settledAfter = (ms: number, use: (c: BinanceClientApi) => Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      const { fn } = stub(() => json(tickerFixture));
      const client = yield* make({ rateLimitScope: "memory" });
      const fiber = yield* Effect.fork(use(client).pipe(Effect.provideService(Fetcher, fn)));
      yield* TestClock.adjust(Duration.millis(ms));
      // 假 fetch 是 `Promise.resolve`,**不归 TestClock 管** —— 推完虚拟时钟不等于它已经跑完。
      // 只 adjust 就 poll 的话「没被闸拦住」那一侧是靠运气过的。让出几轮微任务把它跑干净;
      // 被闸拦住的那一侧在等虚拟时钟,让多少轮都不会完成,所以两侧都仍然准。
      yield* Effect.repeatN(Effect.yieldNow(), 50);
      return Option.isSome(yield* Fiber.poll(fiber));
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise);

  const nTimes =
    (n: number, one: (c: BinanceClientApi) => Effect.Effect<unknown>) => (c: BinanceClientApi) =>
      Effect.all(Array.from({ length: n }, () => one(c)));

  it("公开价表过闸:超出突发的那一发要等", async () => {
    const seven = nTimes(7, (c) => Effect.orDie(c.tickerPrices));
    expect(await settledAfter(2499, seven)).toBe(false);
    expect(await settledAfter(2500, seven)).toBe(true);
  });

  it("签名端点不过闸:连发多少都不等", async () => {
    // 每账户一发、不并发 —— 装闸拦不到东西,还会把互不相干的账户排成一队白等。
    //
    // **这条不能照上面 fork + poll 那套写**:签名端点链路里有 `crypto.subtle`,在 Node 上走线程池 ——
    // 那是**宏任务**,`yieldNow` 只让微任务,推不动它,于是 poll 到的「还没完成」是假的(全量跑时挂过)。
    // 改成跑到底再问虚拟时钟走了多远:走了 0ms 就是一发都没等过,与调度快慢无关。
    const elapsed = await Effect.gen(function* () {
      const { fn } = stub(() => json(accountFixture));
      const client = yield* make({ rateLimitScope: "memory" });
      yield* nTimes(10, (c) => Effect.orDie(c.spotAccount(CREDS)))(client).pipe(
        Effect.provideService(Fetcher, fn),
      );
      return yield* TestClock.currentTimeMillis;
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext), Effect.runPromise);

    expect(elapsed).toBe(0);
  });
});
