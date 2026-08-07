import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import type { ConnectorError, ProviderNeeds } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { zerionProvider } from "../../../src/connectors/evm/zerion-provider";
import chains from "./fixtures/zerion-chains.json";
import expected from "./fixtures/zerion-expected-balances.json";
import positions from "./fixtures/zerion-positions.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const KEY = "zerion-key";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

function upstream(routes: Record<string, () => Response> = {}): HttpStub {
  return httpStub((request) => {
    const path = request.url.pathname;
    for (const [fragment, reply] of Object.entries(routes)) {
      if (path.includes(fragment)) return reply();
    }
    if (path.includes("/v1/chains")) return json(chains);
    if (path.includes("/positions")) return json(positions);
    return json({}); // portfolio
  });
}

type Ctx = Parameters<typeof zerionProvider.fetchBalances>[0];
const ctx = (providerCreds: Record<string, string> = { ZERION_API_KEY: KEY }): Ctx =>
  ({
    account: { id: "a1", label: "EVM", connectorId: "evm", creds: { address: ADDR } },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("fetchBalances", () => {
  // ⚠️ **这一条必须排第一。** 链映射在 client 里缓存 24 小时,而那份缓存是**模块级**的
  // (CF Workers 上放 Scope 里等于每请求重置 —— 见 CODING.md 的 Effect 一节)。
  // 只有还没人拉到过链清单时,拉失败才会是硬失败;之后就落到旧值了(那正是下面第二条)。
  it("冷启 + 链清单挂了 → **整体失败**,绝不写一份含分叉标识的快照", async () => {
    // 拿不到数字 chainId 就产不出规范的 `evm:<chainId>`,而退化成 slug 兜底形会与规范形分裂
    // 身份、污染代币索引。失败即不产,整轮重试。
    const stub = upstream({ "/v1/chains": () => json({}, { status: 500 }) });
    const err = await failing(stub, zerionProvider.fetchBalances(ctx()));
    expect(err._tag).toBe("ConnectorUnavailableError");
  });

  it("并发取仓位 + 链映射,输出与 golden 一致", async () => {
    const stub = upstream();
    const { balances } = await run(stub, zerionProvider.fetchBalances(ctx()));
    expect(balances).toEqual(expected);
  });

  it("拉过一次之后链清单再挂 → **落回旧映射照常出余额**(缓存的三条理由之一)", async () => {
    const stub = upstream({ "/v1/chains": () => json({}, { status: 500 }) });
    const { balances } = await run(stub, zerionProvider.fetchBalances(ctx()));
    // 链的 chainId 不可变,旧映射仍然正确 —— 比让整轮取数失败强。
    expect(balances).toEqual(expected);
  });

  it("Basic 认证:key 作 username、密码空", async () => {
    const stub = upstream();
    await run(stub, zerionProvider.fetchBalances(ctx()));
    const auth = stub.calls[0].request.headers.authorization;
    expect(auth).toBe(`Basic ${btoa(`${KEY}:`)}`);
  });

  it("**没配 provider key → 归凭据问题,而且一发都不出网**", async () => {
    const stub = upstream();
    const err = await failing(stub, zerionProvider.fetchBalances(ctx({})));
    expect(err._tag).toBe("ConnectorAuthError");
    expect(stub.calls).toHaveLength(0);
  });

  it("是备源:defaultEnabled=false,且声明 ZERION_API_KEY", () => {
    expect(zerionProvider.id).toBe("zerion");
    expect(zerionProvider.defaultEnabled).toBe(false);
    expect(zerionProvider.creds.map((f) => f.key)).toEqual(["ZERION_API_KEY"]);
  });
});

describe("validateAccount", () => {
  it("200 → true(打轻量 portfolio)", async () => {
    const stub = httpStub(() => json({}));
    expect(await run(stub, zerionProvider.validateAccount(ctx()))).toBe(true);
    expect(stub.calls[0].request.url.pathname).toContain("portfolio");
  });

  it("没配 key → false,一发都不出网", async () => {
    const stub = httpStub(() => json({}));
    expect(await run(stub, zerionProvider.validateAccount(ctx({})))).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("凭据被拒(401)→ false;5xx → 走错误通道", async () => {
    const denied = httpStub(() => json({}, { status: 401 }));
    expect(await run(denied, zerionProvider.validateAccount(ctx()))).toBe(false);
    const down = httpStub(() => json({}, { status: 503 }));
    expect((await failing(down, zerionProvider.validateAccount(ctx())))._tag).toBe(
      "ConnectorUnavailableError",
    );
  });
});
