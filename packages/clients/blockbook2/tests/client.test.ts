import { Fetcher, type UpstreamError } from "@folio/client-core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type BlockbookClientApi, type BlockbookConfig, make } from "../src/client";
import { BLOCKBOOK_BASES, USER_AGENT } from "../src/constants";

const XPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const ADDR = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

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

function stub(reply: (url: URL, nth: number) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fn = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    return Promise.resolve(reply(url, calls.length - 1));
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

const XPUB_BODY = {
  address: XPUB,
  balance: "12345",
  unconfirmedBalance: "0",
  unconfirmedTxs: 0,
  txs: 3,
};
const ADDR_BODY = { address: ADDR, balance: "500", unconfirmedBalance: "0" };

// 构造是纯的(没有闸就没有 Scope)。
const withClient = <A, E>(
  fn: typeof globalThis.fetch,
  use: (client: BlockbookClientApi) => Effect.Effect<A, E, Fetcher>,
  config: BlockbookConfig = {},
): Promise<A> => Effect.runPromise(Effect.provideService(use(make(config)), Fetcher, fn));

const failing = (
  fn: typeof globalThis.fetch,
  use: (c: BlockbookClientApi) => Effect.Effect<unknown, UpstreamError, Fetcher>,
  config: BlockbookConfig = {},
): Promise<UpstreamError> => withClient(fn, (c) => Effect.flip(use(c)), config);

// 轮询起点是模块级的(刻意:不让每轮同步都从 btc2 开始),所以断言「打了哪个 base」会跨用例漂。
// 给每个用例自己的 bases,断言就只看**打了几发、按什么顺序在这几个之间走**。
const basesOf = (n: number) => Array.from({ length: n }, (_, i) => `https://node${i}.test/api/v2`);

describe("请求形状", () => {
  it("xpub:服务端派生,details / tokens 走 query 不焊进 path", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });

    expect(calls[0].url.pathname).toBe(`/api/v2/xpub/${XPUB}`);
    expect(calls[0].url.searchParams.get("details")).toBe("tokenBalances");
    expect(calls[0].url.searchParams.get("tokens")).toBe("used");
  });

  it("xpub 的 query 可覆盖", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB, { details: "basic", tokens: "derived" }), {
      bases: basesOf(1),
    });
    expect(calls[0].url.searchParams.get("details")).toBe("basic");
    expect(calls[0].url.searchParams.get("tokens")).toBe("derived");
  });

  it("descriptor 的括号被编码掉", async () => {
    // `tr(xpub…)` 这种 descriptor 直接进 path 会让某些节点解析出错。
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(`tr(${XPUB})`), { bases: basesOf(1) });
    expect(calls[0].url.href).toContain("%28");
    expect(calls[0].url.href).toContain("%29");
  });

  it("address:单地址", async () => {
    const { fn, calls } = stub(() => json(ADDR_BODY));
    await withClient(fn, (c) => c.address(ADDR), { bases: basesOf(1) });
    expect(calls[0].url.pathname).toBe(`/api/v2/address/${ADDR}`);
  });

  it("**必须带 User-Agent**(Workers 的 fetch 默认不带,WAF 会 403)", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    expect((calls[0].init?.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("UA 刻意中性 —— 不带项目名、不带仓库地址", () => {
    // 请求内容本身就是敏感的(带着 xpub)。UA 里写上「某某项目」等于把「谁在看这个地址」
    // 和一个具体的人绑在一起,还让所有自托管实例可被归成一类。
    expect(USER_AGENT).toBe("Mozilla/5.0");
    expect(USER_AGENT.toLowerCase()).not.toContain("folio");
  });

  it("原样吐上游形状,不做任何翻译", async () => {
    // satoshi 仍是字符串 —— 转数字归适配层。
    const { fn } = stub(() => json(XPUB_BODY));
    const res = await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    expect(res).toEqual(XPUB_BODY);
    expect(typeof res.balance).toBe("string");
  });

  it("不传 bases 就用内置的四个公共节点", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB));
    expect(BLOCKBOOK_BASES).toContain(`${calls[0].url.origin}/api/v2`);
  });
});

describe("多端点:换节点就是这家上游的「重试」", () => {
  it("某个节点限流 → 换下一个", async () => {
    const { fn, calls } = stub((_u, nth) =>
      nth === 0 ? json({}, { status: 429 }) : json(XPUB_BODY),
    );
    const res = await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(4) });
    expect(res).toEqual(XPUB_BODY);
    expect(calls).toHaveLength(2);
    // 换的是**下一个**节点,不是重打同一个。
    expect(calls[0].url.origin).not.toBe(calls[1].url.origin);
  });

  it("5xx 与网络失败也换", async () => {
    for (const first of [() => json({}, { status: 503 }), () => Promise.reject(new Error("dns"))]) {
      const { fn, calls } = stub((_u, nth) => (nth === 0 ? first() : json(XPUB_BODY)));
      await withClient(fn, (c) => c.xpub(XPUB), { bases: basesOf(4) });
      expect(calls).toHaveLength(2);
    }
  });

  it("**4xx 不换** —— 无效 xpub 换四个节点会得到四个一样的 400", async () => {
    // 老实现靠 `retryable: false` 表达这条;这里靠 status 分开,因为「够不到上游」那一类
    // 同时涵盖了网络失败、5xx 和 4xx,而只有前两者换了才有意义。
    const { fn, calls } = stub(() => json({ error: "invalid xpub" }, { status: 400 }));
    const err = await failing(fn, (c) => c.xpub("garbage"), { bases: basesOf(4) });
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(calls).toHaveLength(1); // 白赔三次往返的那三发没有发生
  });

  it("凭据被拒 / 读不懂的响应也不换", async () => {
    const { fn: auth, calls: authCalls } = stub(() => json({}, { status: 403 }));
    expect((await failing(auth, (c) => c.xpub(XPUB), { bases: basesOf(4) }))._tag).toBe(
      "UpstreamAuthError",
    );
    expect(authCalls).toHaveLength(1);

    const { fn: junk, calls: junkCalls } = stub(() => new Response("<html>", { status: 200 }));
    expect((await failing(junk, (c) => c.xpub(XPUB), { bases: basesOf(4) }))._tag).toBe(
      "UpstreamParseError",
    );
    expect(junkCalls).toHaveLength(1);
  });

  it("全都挂了 → 报最后一个节点的错,且**每个节点只试一次**", async () => {
    const { fn, calls } = stub(() => json({}, { status: 503 }));
    const err = await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(4) });
    expect(err._tag).toBe("UpstreamUnavailableError");
    expect(calls).toHaveLength(4);
  });

  it("轮询起点会移动 —— 不让每一轮都从同一个节点开始", async () => {
    const bases = basesOf(4);
    const seen: string[] = [];
    const { fn } = stub((url) => {
      seen.push(url.origin);
      return json(XPUB_BODY);
    });
    for (let i = 0; i < 4; i++) {
      await withClient(fn, (c) => c.xpub(XPUB), { bases });
    }
    // 四次调用应该打到不止一个节点(起点每次前进一格)。
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it("bases 传空数组 → 回落到内置列表,不是打不出去", async () => {
    const { fn, calls } = stub(() => json(XPUB_BODY));
    await withClient(fn, (c) => c.xpub(XPUB), { bases: [] });
    expect(calls).toHaveLength(1);
  });
});

describe("错误归类", () => {
  it("错误带 upstream,答「是谁失败的」", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    expect((await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) })).upstream).toBe(
      "blockbook",
    );
  });

  it("429 带上 Retry-After", async () => {
    const { fn } = stub(() => json({}, { status: 429, headers: { "retry-after": "6" } }));
    const err = await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    expect(err._tag).toBe("UpstreamRateLimitError");
    expect(err._tag === "UpstreamRateLimitError" && err.retryAfterMs).toBe(6000);
  });

  it("失败信息不带 query;xpub 在 pathname 里是躲不掉的", async () => {
    const { fn } = stub(() => json({}, { status: 503 }));
    const err = await failing(fn, (c) => c.xpub(XPUB), { bases: basesOf(1) });
    // query 不进 —— details/tokens 那两个参数不在 where 里。
    expect(err.where).not.toContain("details");
    // 但 Blockbook 的 URL 形状就是 /xpub/{token},xpub 一定在 pathname 里。
    // 它在本仓分类是 public(明文落库),所以可接受 —— 这条钉住的是「知道它在这儿」。
    expect(err.where).toContain("/xpub/");
  });
});
