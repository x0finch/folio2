import type { Outbound, UpstreamError } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { BybitClient, type BybitClientApi, type BybitConfig, make } from "../src/client";
import {
  BYBIT_API_BASE,
  EARN_CATEGORY_FLEXIBLE,
  HEADER_KEY,
  HEADER_RECV_WINDOW,
  HEADER_SIGN,
  HEADER_SIGN_TYPE,
  HEADER_TIMESTAMP,
  RECV_WINDOW,
} from "../src/constants";
import earnFixture from "./fixtures/earn-flexible.json" with { type: "json" };
import fundingFixture from "./fixtures/funding.json" with { type: "json" };
import walletFixture from "./fixtures/wallet-balance.json" with { type: "json" };

const CREDS = { apiKey: "the-key", secret: "the-secret" } as const;

// 参考实现:**不调被测代码的 `hmacSha256`**,独立走一遍 WebCrypto。要验的是「到底把哪一串
// 拿去签了」—— HMAC 算法本身由 WebCrypto 保证,不是这里的被测对象。
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

// 假出网:记下每一发。顶替的是 **`HttpClient` 服务**而不是 `globalThis.fetch` ——
// 请求层底下是官方客户端,在那一层顶替才测得到真实路径(签名头、method、body 都经过它)。
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// 构造是纯的(没有闸就没有 Scope)。TestClock 下 `Clock.currentTimeMillis` 从 0 起 ——
// 于是签名串确定,可以拿参考实现对。
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: BybitClientApi) => Effect.Effect<A, E, Outbound>,
  config: BybitConfig = {},
): Promise<A> => runClient(fn, use(make(config)));

const failing = (
  fn: HttpStub,
  use: (c: BybitClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

const headersOf = (seen: { request: { headers: Record<string, string> } }) => seen.request.headers;

describe("签名", () => {
  it("签的是 timestamp + apiKey + recvWindow + queryString,且与发出去的 query 一字不差", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));

    const h = headersOf(calls[0]);
    // 实际发出去的 query —— 被签串必须用**它**,不是某个另行拼的版本。
    const sentQuery = calls[0].request.url.searchParams.toString();
    expect(sentQuery).toBe("accountType=UNIFIED");
    // TestClock 下 timestamp 是 0。
    expect(h[HEADER_TIMESTAMP]).toBe("0");
    expect(h[HEADER_SIGN]).toBe(
      await hmacHex(CREDS.secret, `0${CREDS.apiKey}${RECV_WINDOW}${sentQuery}`),
    );
  });

  it("五个签名头都带上(少一个 Bybit 就回 10004)", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));
    const h = headersOf(calls[0]);
    expect(h[HEADER_KEY]).toBe(CREDS.apiKey);
    expect(h[HEADER_RECV_WINDOW]).toBe(RECV_WINDOW);
    expect(h[HEADER_SIGN_TYPE]).toBe("2");
    expect(h[HEADER_SIGN]).toBeTruthy();
  });

  it("secret 不进 query、不进头", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));
    expect(calls[0].request.url.href).not.toContain(CREDS.secret);
    expect(JSON.stringify(headersOf(calls[0]))).not.toContain(CREDS.secret);
  });
});

describe("端点打对路径 / query", () => {
  it("统一账户:accountType=UNIFIED", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS));
    expect(calls[0].request.url.origin).toBe(BYBIT_API_BASE);
    expect(calls[0].request.url.pathname).toBe("/v5/account/wallet-balance");
    expect(calls[0].request.url.searchParams.get("accountType")).toBe("UNIFIED");
  });

  it("资金账户:accountType=FUND", async () => {
    const { fn, calls } = stub(() => json(fundingFixture));
    await withClient(fn, (c) => c.fundingBalances(CREDS));
    expect(calls[0].request.url.pathname).toBe("/v5/asset/transfer/query-account-coins-balance");
    expect(calls[0].request.url.searchParams.get("accountType")).toBe("FUND");
  });

  it("赚币:category 由调用方给(拉哪几个类目是适配层的事)", async () => {
    const { fn, calls } = stub(() => json(earnFixture));
    await withClient(fn, (c) => c.earnPositions(CREDS, EARN_CATEGORY_FLEXIBLE));
    expect(calls[0].request.url.pathname).toBe("/v5/earn/position");
    expect(calls[0].request.url.searchParams.get("category")).toBe("FlexibleSaving");
  });

  it("apiBase 可覆盖,且当不透明整串用(代理 #264)", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    await withClient(fn, (c) => c.walletBalance(CREDS), {
      apiBase: "http://localhost:3099/bybit-proxy",
    });
    expect(calls[0].request.url.href).toContain("/bybit-proxy/v5/account/wallet-balance");
  });

  it("原样吐上游形状,不做任何翻译", async () => {
    const { fn } = stub(() => json(walletFixture));
    const res = await withClient(fn, (c) => c.walletBalance(CREDS));
    expect(res).toEqual(walletFixture);
  });
});

describe("业务码(HTTP 200 + retCode)", () => {
  // **这是 Bybit 最容易踩的一点。** 不查 retCode 的话,签名错会被当成功、result 为空,
  // 最后表现成「这个账户余额是 0」—— 静默丢数据,比报错难查得多。
  const withRetCode = (retCode: number, retMsg = "boom") =>
    stub(() => json({ retCode, retMsg })).fn;

  it("retCode 0 才算成功", async () => {
    const { fn } = stub(() => json({ retCode: 0, retMsg: "OK", result: { list: [] } }));
    await expect(withClient(fn, (c) => c.walletBalance(CREDS))).resolves.toBeTruthy();
  });

  it("凭据/签名/权限类 retCode → 凭据问题", async () => {
    // 10003 key 非法 / 10004 签名错 / 10005 权限不足 / 10010 IP 不符 / 33004 key 过期
    for (const code of [10003, 10004, 10005, 10010, 33004]) {
      const err = await failing(withRetCode(code), (c) => c.walletBalance(CREDS));
      expect(err._tag).toBe("UpstreamAuthError");
    }
  });

  it("其余 retCode → 上游的锅", async () => {
    const err = await failing(withRetCode(10016), (c) => c.walletBalance(CREDS));
    expect(err._tag).toBe("UpstreamUnavailableError");
  });

  it("retCode 与 retMsg 进 cause,不冒充 HTTP status", async () => {
    // 混进 `status` 的话读日志的人分不清「503」和「10004」是不是同一类东西。
    const err = await failing(withRetCode(10004, "sign check error"), (c) =>
      c.walletBalance(CREDS),
    );
    expect(err.status).toBeUndefined();
    expect(String(err.cause)).toContain("retCode 10004");
    expect(String(err.cause)).toContain("sign check error");
  });

  it("三个端点都查 retCode", async () => {
    const fn = withRetCode(10004);
    expect((await failing(fn, (c) => c.fundingBalances(CREDS)))._tag).toBe("UpstreamAuthError");
    expect((await failing(fn, (c) => c.earnPositions(CREDS, "OnChain")))._tag).toBe(
      "UpstreamAuthError",
    );
  });
});

it("上游回一个裸 null → parse,不是崩", async () => {
  // `null` 是合法的 200 JSON。直接读它的字段会抛 TypeError —— 那是 defect,不进错误通道。
  const { fn } = stub(() => json(null));
  expect((await failing(fn, (c) => c.walletBalance(CREDS)))._tag).toBe("UpstreamParseError");
});

describe("HTTP 层错误归类", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ retCode: 0 }, init));
    return failing(fn, (c) => c.walletBalance(CREDS));
  };

  it("401 / 403 → 凭据问题", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 → 限流,带上 Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "2" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(2000);
  });

  it("5xx → 够不到上游", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("读不成 JSON → parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.walletBalance(CREDS)))._tag).toBe("UpstreamParseError");
  });

  it("失败信息不带 secret / query(原则 #5 红线)", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("bybit");
    expect(err.where).toBe("/v5/account/wallet-balance");
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.apiKey);
  });
});

// **走 Tag / Layer 那一条路。** 生产只走它,而在这之前**九个包的测试一条都没走过** ——
// 全部直接调 `make`,于是「`layer()` 装出来的东西和 `make` 是不是同一个」从来没人验证。
// 这是复审点出来的真空档(#12)。
describe("装配:Tag 路径", () => {
  it("`BybitClient.layer(...)` 装出来的就是 `make` 那个 client", async () => {
    const { fn, calls } = stub(() => json(walletFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(BybitClient, (client) => client.walletBalance(CREDS)).pipe(
        Effect.provide(BybitClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
