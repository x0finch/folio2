import type { Outbound, UpstreamError } from "@folio/client-core";
import {
  type HttpStub,
  httpStub,
  jsonResponse as json,
  runClient,
} from "@folio/client-core/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { make, OkxClient, type OkxClientApi, type OkxConfig } from "../src/client";
import {
  HEADER_KEY,
  HEADER_PASSPHRASE,
  HEADER_SIGN,
  HEADER_TIMESTAMP,
  OKX_API_BASE,
} from "../src/constants";
import balanceFixture from "./fixtures/balance.json" with { type: "json" };
import fundingFixture from "./fixtures/funding.json" with { type: "json" };
import savingsFixture from "./fixtures/savings.json" with { type: "json" };
import valuationFixture from "./fixtures/valuation.json" with { type: "json" };

const CREDS = { apiKey: "the-key", secret: "the-secret", passphrase: "the-phrase" } as const;

// 参考实现:**不调被测代码的 `hmacSha256`**,独立走一遍 WebCrypto。要验的是「到底把哪一串签了」。
async function hmacB64(secret: string, message: string): Promise<string> {
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
  return btoa(String.fromCharCode(...sig));
}

// 假出网:记下每一发。顶替的是 **`HttpClient` 服务**而不是 `globalThis.fetch` ——
// 请求层底下是官方客户端,在那一层顶替才测得到真实路径(签名头、method、body 都经过它)。
function stub(reply: (url: URL) => Response | Promise<Response>) {
  const s = httpStub((request) => reply(request.url));
  return { fn: s, calls: s.calls };
}

// 构造是纯的(没有闸)。TestClock 下时钟从 0 起 → 时间戳是 1970-01-01T00:00:00.000Z,签名串确定。
const withClient = <A, E>(
  fn: HttpStub,
  use: (client: OkxClientApi) => Effect.Effect<A, E, Outbound>,
  config: OkxConfig = {},
): Promise<A> => runClient(fn, use(make(config)));

const failing = (
  fn: HttpStub,
  use: (c: OkxClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>,
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)));

const headersOf = (seen: { request: { headers: Record<string, string> } }) => seen.request.headers;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

describe("签名", () => {
  it("签的是 ISO 时间戳 + GET + requestPath,base64 编码", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS));

    const h = headersOf(calls[0]);
    // 时间戳是 **ISO 串**,不是毫秒数 —— 与 binance / Bybit 都不同。
    expect(h[HEADER_TIMESTAMP]).toBe(EPOCH_ISO);
    expect(h[HEADER_SIGN]).toBe(
      await hmacB64(CREDS.secret, `${EPOCH_ISO}GET/api/v5/account/balance`),
    );
  });

  it("**有 query 时 requestPath 必须含它** —— 少了这一段 OKX 回 50113", async () => {
    // asset-valuation 是唯一带 query 的端点。老代码把 `?ccy=USD` 焊进路径常量绕过去了;
    // 这里 query 正常走 `makeRequester`,由签名那一步拼回去 —— 这条就是钉住那次拼装。
    const { fn, calls } = stub(() => json(valuationFixture));
    await withClient(fn, (c) => c.assetValuation(CREDS));

    expect(calls[0].request.url.searchParams.get("ccy")).toBe("USD");
    expect(headersOf(calls[0])[HEADER_SIGN]).toBe(
      await hmacB64(CREDS.secret, `${EPOCH_ISO}GET/api/v5/asset/asset-valuation?ccy=USD`),
    );
  });

  it("passphrase 走自己的头(binance / Bybit 都没有这一项)", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS));
    const h = headersOf(calls[0]);
    expect(h[HEADER_PASSPHRASE]).toBe(CREDS.passphrase);
    expect(h[HEADER_KEY]).toBe(CREDS.apiKey);
  });

  it("secret 与 passphrase 不进 query", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS));
    expect(calls[0].request.url.href).not.toContain(CREDS.secret);
    expect(calls[0].request.url.href).not.toContain(CREDS.passphrase);
  });
});

describe("端点打对路径", () => {
  const paths: Array<
    [string, (c: OkxClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>]
  > = [
    ["/api/v5/account/balance", (c) => c.balance(CREDS)],
    ["/api/v5/asset/balances", (c) => c.fundingBalances(CREDS)],
    ["/api/v5/finance/savings/balance", (c) => c.savingsBalance(CREDS)],
    ["/api/v5/finance/staking-defi/orders-active", (c) => c.stakingOrders(CREDS)],
    ["/api/v5/asset/asset-valuation", (c) => c.assetValuation(CREDS)],
    ["/api/v5/account/positions", (c) => c.positions(CREDS)],
  ];

  for (const [path, call] of paths) {
    it(path, async () => {
      const { fn, calls } = stub(() => json({ code: "0", data: [] }));
      await withClient(fn, call);
      expect(calls[0].request.url.origin).toBe(OKX_API_BASE);
      expect(calls[0].request.url.pathname).toBe(path);
    });
  }

  it("apiBase 可覆盖,且当不透明整串用(代理 #264)", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    await withClient(fn, (c) => c.balance(CREDS), { apiBase: "http://localhost:3099/okx-proxy" });
    expect(calls[0].request.url.href).toContain("/okx-proxy/api/v5/account/balance");
  });

  it("原样吐上游形状,不做任何翻译", async () => {
    const { fn } = stub(() => json(fundingFixture));
    expect(await withClient(fn, (c) => c.fundingBalances(CREDS))).toEqual(fundingFixture);
  });
});

describe("业务码(HTTP 200 + code)", () => {
  // 与 Bybit 同一个坑,只是 OKX 的 code 是**字符串**。不查它的话,签名错会被当成功、data 为空,
  // 最后表现成「这个账户余额是 0」—— 静默丢数据。
  const withCode = (code: string, msg = "boom") => stub(() => json({ code, msg })).fn;

  it("code '0' 才算成功", async () => {
    const { fn } = stub(() => json(savingsFixture));
    await expect(withClient(fn, (c) => c.savingsBalance(CREDS))).resolves.toBeTruthy();
  });

  it("凭据/签名/权限类 code → 凭据问题", async () => {
    // 50100 冻结 / 50102 时间戳过期 / 50105 passphrase 错 / 50111 key 非法 / 50113 签名错
    for (const code of ["50100", "50102", "50105", "50111", "50113"]) {
      expect((await failing(withCode(code), (c) => c.balance(CREDS)))._tag).toBe(
        "UpstreamAuthError",
      );
    }
  });

  it("其余 code → 上游的锅", async () => {
    expect((await failing(withCode("51000"), (c) => c.balance(CREDS)))._tag).toBe(
      "UpstreamUnavailableError",
    );
  });

  it("code 与 msg 进 cause,不冒充 HTTP status", async () => {
    const err = await failing(withCode("50113", "Invalid Sign"), (c) => c.balance(CREDS));
    expect(err.status).toBeUndefined();
    expect(String(err.cause)).toContain("code 50113");
    expect(String(err.cause)).toContain("Invalid Sign");
  });

  it("六个端点都查 code", async () => {
    const fn = withCode("50113");
    const calls: Array<(c: OkxClientApi) => Effect.Effect<unknown, UpstreamError, Outbound>> = [
      (c) => c.balance(CREDS),
      (c) => c.fundingBalances(CREDS),
      (c) => c.savingsBalance(CREDS),
      (c) => c.stakingOrders(CREDS),
      (c) => c.assetValuation(CREDS),
      (c) => c.positions(CREDS),
    ];
    for (const call of calls) {
      expect((await failing(fn, call))._tag).toBe("UpstreamAuthError");
    }
  });
});

it("上游回一个裸 null → parse,不是崩", async () => {
  // `null` 是合法的 200 JSON。直接读它的字段会抛 TypeError —— 那是 defect,不进错误通道。
  const { fn } = stub(() => json(null));
  expect((await failing(fn, (c) => c.balance(CREDS)))._tag).toBe("UpstreamParseError");
});

describe("HTTP 层错误归类", () => {
  const failWith = (init: ResponseInit) => {
    const { fn } = stub(() => json({ code: "0" }, init));
    return failing(fn, (c) => c.balance(CREDS));
  };

  it("401 / 403 → 凭据问题", async () => {
    for (const status of [401, 403]) {
      expect((await failWith({ status }))._tag).toBe("UpstreamAuthError");
    }
  });

  it("429 → 限流,带上 Retry-After", async () => {
    const err = await failWith({ status: 429, headers: { "retry-after": "4" } });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(4000);
  });

  it("5xx → 够不到上游", async () => {
    expect((await failWith({ status: 503 }))._tag).toBe("UpstreamUnavailableError");
  });

  it("读不成 JSON → parse", async () => {
    const { fn } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(fn, (c) => c.balance(CREDS)))._tag).toBe("UpstreamParseError");
  });

  it("失败信息不带凭据(原则 #5 红线)", async () => {
    const err = await failWith({ status: 503 });
    expect(err.upstream).toBe("okx");
    expect(err.where).toBe("/api/v5/account/balance");
    const dump = JSON.stringify(err);
    expect(dump).not.toContain(CREDS.secret);
    expect(dump).not.toContain(CREDS.passphrase);
  });
});

// **走 Tag / Layer 那一条路。** 生产只走它,而在这之前**九个包的测试一条都没走过** ——
// 全部直接调 `make`,于是「`layer()` 装出来的东西和 `make` 是不是同一个」从来没人验证。
// 这是复审点出来的真空档(#12)。
describe("装配:Tag 路径", () => {
  it("`OkxClient.layer(...)` 装出来的就是 `make` 那个 client", async () => {
    const { fn, calls } = stub(() => json(balanceFixture));
    const out = await runClient(
      fn,
      Effect.flatMap(OkxClient, (client) => client.balance(CREDS)).pipe(
        Effect.provide(OkxClient.layer()),
      ),
    );
    expect(out).toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
