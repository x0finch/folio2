import { resetLimitsForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CG_BURST, CG_RETRY_MAX_WAIT_MS } from "../src/constants";
import { type CoinGeckoError, createCoinGeckoClient } from "../src/index";

// 限速闸与重试。**规则层面**的「为什么」在 src/constants.ts,这里管「整条链拼起来对不对」。
// sleep 一律注入即时版并记账 —— 于是「等了几次、各等多久」是可断言的,而测试不真等一秒钟。

function scriptedFetch(responses: Array<Partial<Response>>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
    return res as Response;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fn as unknown as typeof fetch);
  return fn;
}

const ok = (body: unknown): Partial<Response> => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: new Headers(),
});
const tooMany = (retryAfter?: string): Partial<Response> => ({
  ok: false,
  status: 429,
  headers: new Headers(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
});

function newClient(apiKey = "k") {
  const slept: number[] = [];
  const client = createCoinGeckoClient({ apiKey, sleep: async (ms) => void slept.push(ms) });
  return { client, slept };
}

async function grabErr(p: Promise<unknown>): Promise<CoinGeckoError> {
  try {
    await p;
    throw new Error("expected to throw");
  } catch (e) {
    return e as CoinGeckoError;
  }
}

beforeEach(() => resetLimitsForTests());
afterEach(() => vi.restoreAllMocks());

describe("重试", () => {
  it("429 + Retry-After: 1 → 重试一次并成功,对外不抛", async () => {
    const f = scriptedFetch([tooMany("1"), ok([{ id: "ethereum" }])]);
    const { client } = newClient();
    expect(await client.assetPlatforms()).toEqual([{ id: "ethereum" }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("Retry-After 超过上限 → 不等,立刻抛,且带着 retryAfterMs 供调用方决策", async () => {
    const f = scriptedFetch([tooMany("60")]); // 60s ≫ 2s 上限
    const { client, slept } = newClient();
    const err = await grabErr(client.assetPlatforms());
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryAfterMs).toBe(60_000);
    expect(f).toHaveBeenCalledTimes(1); // 一次都没重试
    expect(slept).toEqual([]); // 也没等
  });

  it("Retry-After 缺失 → 用退避,不是无限等", async () => {
    scriptedFetch([tooMany(), ok([])]);
    const { client, slept } = newClient();
    await client.assetPlatforms();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(CG_RETRY_MAX_WAIT_MS);
    expect(slept[0]).toBeGreaterThan(0);
  });

  it("非 retryable(400)→ 一次都不重试", async () => {
    const f = scriptedFetch([{ ok: false, status: 400, headers: new Headers() }]);
    const { client } = newClient();
    expect((await grabErr(client.assetPlatforms())).code).toBe("UPSTREAM_ERROR");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("5xx 会重试(它本来就标了 retryable)", async () => {
    const f = scriptedFetch([{ ok: false, status: 503, headers: new Headers() }, ok([])]);
    const { client } = newClient();
    await client.assetPlatforms();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("notFoundAsNull 的 404 仍返回 null,且不进重试", async () => {
    const f = scriptedFetch([{ ok: false, status: 404, headers: new Headers() }]);
    const { client } = newClient();
    expect(await client.exchange("binance")).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("重试用尽 → 抛最后一次的错误(而不是第一次的)", async () => {
    const f = scriptedFetch([tooMany("1"), { ok: false, status: 503, headers: new Headers() }]);
    const { client } = newClient();
    expect((await grabErr(client.assetPlatforms())).code).toBe("UPSTREAM_ERROR");
    expect(f).toHaveBeenCalledTimes(2); // CG_RETRY_ATTEMPTS
  });

  it("坏 JSON → PARSE_ERROR,不重试(重试不会让 JSON 变好)", async () => {
    const f = scriptedFetch([
      {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error("bad json");
        },
      },
    ]);
    const { client } = newClient();
    expect((await grabErr(client.assetPlatforms())).code).toBe("PARSE_ERROR");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("限速闸", () => {
  it("突发额度用完之后请求被摊开,不挤在一起", async () => {
    scriptedFetch([ok([])]);
    const { client, slept } = newClient();
    for (let i = 0; i < CG_BURST + 3; i++) await client.assetPlatforms();
    // 头 CG_BURST 发不等,之后每发都等,而且越排越后
    expect(slept).toHaveLength(3);
    expect(slept[1]).toBeGreaterThan(slept[0]);
    expect(slept[2]).toBeGreaterThan(slept[1]);
  });

  it("撞过 429 之后进入冷却 —— 后续调用立刻失败,不再打上游", async () => {
    // 第一发 429(Retry-After 60s,超上限 → 直接抛),这一下写进冷却标记。
    const f = scriptedFetch([tooMany("60")]);
    const { client } = newClient();
    await grabErr(client.assetPlatforms());
    expect(f).toHaveBeenCalledTimes(1);

    // 第二发压根不该出网:冷却期内闸直接拒。
    const err = await grabErr(client.coinsList());
    expect(err.code).toBe("RATE_LIMITED");
    expect(f).toHaveBeenCalledTimes(1); // 没有新的出网请求
  });

  it("无 key 与有 key 是两份额度(前者按 IP 算)—— 闸不共用", async () => {
    scriptedFetch([tooMany("60")]);
    const keyed = createCoinGeckoClient({ apiKey: "k", sleep: async () => {} });
    const keyless = createCoinGeckoClient({ sleep: async () => {} });
    await grabErr(keyed.assetPlatforms()); // 让有 key 那份进冷却
    // 无 key 那份不受影响 —— 它会真的出网(于是拿到同一个 429,而不是被冷却拦下)
    scriptedFetch([ok([])]);
    expect(await keyless.assetPlatforms()).toEqual([]);
  });
});
