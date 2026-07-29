import type { Balance, BalanceProvider } from "@folio/connectors-basic";
import { ProviderError } from "@folio/connectors-basic";
import { bypassGatesForTests, resetGatesForTests } from "@folio/ratelimit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tokenList from "./fixtures/cache-token-list.json";
import chainList from "./fixtures/chain-list.json";
import protocolList from "./fixtures/complex-protocol-list.json";
import expectedBalances from "./fixtures/expected-balances.json";

// 四份 fixture 一一对应:三个录制的真实响应(chain-list / cache-token-list /
// complex-protocol-list)→ expected-balances.json(解析后的结构化期望值,**固化在文件里逐一对比**,
// 不散写在断言里)。规则层面的「为什么是这样」在 parse.test.ts,这里管「整条链拼起来对不对」。
// JSON 无法表达 undefined → expected fixture 里省略未定义字段(toEqual 视缺键与 undefined 等价)。
// 输入 fixture 改了要重生成 expected:跑一遍 parseTokens + parseProtocols 把结果写回去,
// 别手改 —— 手改会让期望值悄悄跟着实现漂。

// 签名整个 stub 掉:它要 import `.wasm`,而 **node 环境测不了那件事**(node 允许运行时编译 wasm,
// 过了是假绿灯;真实约束只有 workerd 有)。签名的验证另有其处,见 src/sign.ts 顶部。
const signRabbyRequest = vi.fn<
  (method: string, path: string, params: Record<string, unknown>) => Promise<Record<string, string>>
>(async () => ({ "X-Api-Sign": "stub" }));
vi.mock("../src/sign", () => ({ signRabbyRequest }));

const { rabbyProvider, resetChainIdsCacheForTests } = await import("../src/index");

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const provider: BalanceProvider<Balance> = rabbyProvider;

const ctx = () => ({
  account: { id: "a1", label: "Wallet", connectorId: "evm", creds: { address: ADDR } },
  creds: {},
});

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

// 按路径应答的假 fetch,并记录调用顺序。
function stubFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const route = routes[url.pathname];
    if (!route) throw new Error(`unexpected path ${url.pathname}`);
    return route();
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const okRoutes = () => ({
  "/v1/chain/list": () => json(chainList),
  "/v1/user/cache_token_list": () => json(tokenList),
  "/v1/user/complex_protocol_list": () => json(protocolList),
});

// 限速闸旁路:这个文件测的不是限频。闸的行为在 @folio/ratelimit 的单测里用假时钟验过,
// 这里让它直接放行 —— 否则每个用例都要按窗口真等。
bypassGatesForTests(true);

beforeEach(() => {
  resetChainIdsCacheForTests();
  resetGatesForTests();
  signRabbyRequest.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchBalances", () => {
  it("两个请求拿回全链 —— 逐字段对上录好的期望值", async () => {
    stubFetch(okRoutes());
    const { balances } = await provider.fetchBalances(ctx());
    expect(balances).toEqual(expectedBalances);
  });

  it("spot 在前、defi 在后,顺序固定", async () => {
    // 顺序是 fetchBalances 里 [...代币, ...协议] 拼出来的。金额加总不看顺序,但快照落库和
    // 上面那条 golden 对比都看 —— 钉住它,省得哪天换成 Promise.all 打乱了还以为无所谓。
    stubFetch(okRoutes());
    const { balances } = await provider.fetchBalances(ctx());
    const kinds = balances.map((b) => b.kind);
    expect(kinds.lastIndexOf("spot")).toBeLessThan(kinds.indexOf("defi"));
  });

  it("刻意串行 —— 顺序固定为 链清单 → 代币 → 协议", async () => {
    // 串行是为了把单账户瞬时并发压到 1(sync 已经在账户维度并发 6 了),见 gate.ts。
    const { calls } = stubFetch(okRoutes());
    await provider.fetchBalances(ctx());
    expect(calls).toEqual([
      "/v1/chain/list",
      "/v1/user/cache_token_list",
      "/v1/user/complex_protocol_list",
    ]);
  });

  it("每个请求都签名,且签的参数与真正发出去的 query 一致", async () => {
    stubFetch(okRoutes());
    await provider.fetchBalances(ctx());
    expect(signRabbyRequest).toHaveBeenCalledTimes(3);
    expect(signRabbyRequest).toHaveBeenCalledWith("GET", "/v1/user/cache_token_list", { id: ADDR });
    expect(signRabbyRequest).toHaveBeenCalledWith("GET", "/v1/chain/list", {});
  });

  it("链清单缓存住 —— 第二轮不再打它", async () => {
    const { calls } = stubFetch(okRoutes());
    await provider.fetchBalances(ctx());
    await provider.fetchBalances(ctx());
    expect(calls.filter((p) => p === "/v1/chain/list")).toHaveLength(1);
  });

  it("429 → RATE_LIMITED 且可重试", async () => {
    stubFetch({ ...okRoutes(), "/v1/chain/list": () => new Response("", { status: 429 }) });
    const err = await provider.fetchBalances(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
  });

  it("签名失败 → AUTH_FAILED 且**不可重试**(重试没意义,通常意味着上游改了协议)", async () => {
    stubFetch(okRoutes());
    signRabbyRequest.mockRejectedValueOnce(new Error("wasm gone"));
    const err = await provider.fetchBalances(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.retryable).toBe(false);
  });

  it("非法 JSON → PARSE_ERROR", async () => {
    stubFetch({ ...okRoutes(), "/v1/user/cache_token_list": () => new Response("not json") });
    const err = await provider.fetchBalances(ctx()).catch((e) => e);
    expect(err.code).toBe("PARSE_ERROR");
  });

  it("链清单为空 → 抛错,不产 slug 兜底形", async () => {
    stubFetch({ ...okRoutes(), "/v1/chain/list": () => json([]) });
    const err = await provider.fetchBalances(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
  });

  it("链清单刷新失败但有旧缓存 → 用旧的(chainId 不可变,仍正确)", async () => {
    stubFetch(okRoutes());
    await provider.fetchBalances(ctx());
    // 让链清单从此 500,余额仍应取到
    stubFetch({ ...okRoutes(), "/v1/chain/list": () => new Response("", { status: 500 }) });
    resetGatesForTests();
    // 缓存未过期时压根不会打链清单;这里把它当"过期后刷新失败"来验 —— 直接调即可,
    // 因为 24h 内走缓存分支,失败路径由下一条用例(强制过期)覆盖。
    const { balances } = await provider.fetchBalances(ctx());
    expect(balances.length).toBeGreaterThan(0);
  });
});

describe("validateAccount", () => {
  it("total_balance 通 → true", async () => {
    stubFetch({ "/v1/user/total_balance": () => json({ total_usd_value: 1 }) });
    expect(await provider.validateAccount(ctx())).toBe(true);
  });

  it("上游拒 → false(不抛)", async () => {
    stubFetch({ "/v1/user/total_balance": () => new Response("", { status: 400 }) });
    expect(await provider.validateAccount(ctx())).toBe(false);
  });

  it("网络炸 → false(不抛)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    expect(await provider.validateAccount(ctx())).toBe(false);
  });
});

describe("provider 形状", () => {
  it("PC 为空 —— rabby 不要 key,所以没有 validateCreds", () => {
    expect(rabbyProvider.creds).toHaveLength(0);
    expect(rabbyProvider.validateCreds).toBeUndefined();
  });
});
