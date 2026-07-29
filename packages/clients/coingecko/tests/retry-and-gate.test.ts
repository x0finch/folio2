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

  it("两次都 429 → 才对外抛,而且只抛一次", async () => {
    // 验收单上那句「只对外抛一次失败(第二次也 429 才抛)」的字面意思。上面那条测的是第二次
    // 成功;这条测第二次也撞 —— 两次都 429 才轮到调用方看见失败。
    const f = scriptedFetch([tooMany("1"), tooMany("1")]);
    const { client } = newClient();
    const err = await grabErr(client.assetPlatforms());
    expect(err.code).toBe("RATE_LIMITED");
    expect(f).toHaveBeenCalledTimes(2);

    // 而且这一下才写冷却(重试都没救回来 = 不是瞬时抖动)→ 下一发不出网。
    const err2 = await grabErr(client.coinsList());
    expect(err2.code).toBe("RATE_LIMITED");
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

describe("三个档位各走各的桶", () => {
  // 三个 `CG_CALLS_PER_MIN_*` 里,pro 那个在别处一次都没被走到过 —— 补上,免得它是个从没执行过的分支。
  it("pro 档的额度宽得多 → 同样的发数,demo 要等而 pro 不用", async () => {
    scriptedFetch([ok([])]);
    const demoWaits: number[] = [];
    const demo = createCoinGeckoClient({
      apiKey: "k",
      sleep: async (ms) => void demoWaits.push(ms),
    });
    for (let i = 0; i < CG_BURST + 1; i++) await demo.assetPlatforms();
    expect(demoWaits).toHaveLength(1);

    resetLimitsForTests();
    const proWaits: number[] = [];
    const pro = createCoinGeckoClient({
      apiKey: "k",
      pro: true,
      sleep: async (ms) => void proWaits.push(ms),
    });
    for (let i = 0; i < CG_BURST + 1; i++) await pro.assetPlatforms();
    // 桶容量一样,所以第 CG_BURST+1 发同样要等 —— 但等得**短得多**(速率高)。
    expect(proWaits).toHaveLength(1);
    expect(proWaits[0]).toBeLessThan(demoWaits[0]);
  });

  it("pro 与 demo 共用同一把 key 的额度 → 同一个桶(pro 只是同一把 key 换了档)", async () => {
    scriptedFetch([ok([])]);
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const demo = createCoinGeckoClient({ apiKey: "k", sleep });
    const pro = createCoinGeckoClient({ apiKey: "k", pro: true, sleep });
    for (let i = 0; i < CG_BURST; i++) await demo.assetPlatforms();
    await pro.assetPlatforms(); // 突发已被 demo 抽干 → pro 这发也得等
    expect(waits).toHaveLength(1);
  });
});
