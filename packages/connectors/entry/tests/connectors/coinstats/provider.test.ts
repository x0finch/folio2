import { type HttpStub, httpStub, runClient } from "@folio/client-core/testing";
import {
  type ConnectorError,
  type ProviderNeeds,
  validateCredentials,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  coinstatsAccountCreds,
  createCoinstatsProvider,
} from "../../../src/connectors/coinstats/provider";
import solana from "./fixtures/solana.json";

const ADDR = "So11111111111111111111111111111111111111112";
const KEY = "cs-key";

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

type Ctx = Parameters<ReturnType<typeof createCoinstatsProvider>["fetchBalances"]>[0];
const ctx = (providerCreds: Record<string, string> = { COINSTATS_API_KEY: KEY }): Ctx =>
  ({
    account: { id: "a1", label: "Wallet", connectorId: "solana", creds: { address: ADDR } },
    creds: providerCreds,
  }) as unknown as Ctx;

const run = <A>(stub: HttpStub, effect: Effect.Effect<A, ConnectorError, ProviderNeeds>) =>
  runClient(stub, effect);
const failing = (
  stub: HttpStub,
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => runClient(stub, Effect.flip(effect));

describe("工厂:一份适配服务三条链", () => {
  it("每个 connectionId 产出 id=coinstats 的 provider,声明 COINSTATS_API_KEY", () => {
    for (const chain of ["solana", "sui-wallet", "cosmos"]) {
      const provider = createCoinstatsProvider(chain);
      expect(provider.id).toBe("coinstats");
      expect(provider.creds.map((f) => f.key)).toEqual(["COINSTATS_API_KEY"]);
    }
  });

  it("connectionId 绑定各自那条链(sui → 'sui-wallet')", async () => {
    const stub = httpStub(() => json([]));
    await run(stub, createCoinstatsProvider("sui-wallet").fetchBalances(ctx()));
    expect(stub.calls[0].request.url.searchParams.get("connectionId")).toBe("sui-wallet");
  });
});

describe("fetchBalances", () => {
  it("带上 X-API-KEY,解析余额", async () => {
    const stub = httpStub(() => json(solana));
    const { balances } = await run(stub, createCoinstatsProvider("solana").fetchBalances(ctx()));

    expect(balances.length).toBeGreaterThan(0);
    expect(stub.calls[0].request.headers["x-api-key"]).toBe(KEY);
    expect(stub.calls[0].request.url.searchParams.get("address")).toBe(ADDR);
  });

  it("**没配 provider key → 归凭据问题,而且一发都不出网**", async () => {
    const stub = httpStub(() => json([]));
    const err = await failing(stub, createCoinstatsProvider("solana").fetchBalances(ctx({})));
    expect(err._tag).toBe("ConnectorAuthError");
    expect(stub.calls).toHaveLength(0);
  });

  it("429 → 限流;401 → 凭据问题", async () => {
    const limited = httpStub(() => json({}, { status: 429 }));
    expect(
      (await failing(limited, createCoinstatsProvider("solana").fetchBalances(ctx())))._tag,
    ).toBe("ConnectorRateLimitError");
    const denied = httpStub(() => json({}, { status: 401 }));
    expect(
      (await failing(denied, createCoinstatsProvider("solana").fetchBalances(ctx())))._tag,
    ).toBe("ConnectorAuthError");
  });
});

describe("validateAccount", () => {
  it("**没配 key → false,一发都不出网**", async () => {
    // 老那版为它单写了一个 `if (!apiKey) return false` 前置分支。现在没配 key 报的就是
    // 「凭据问题」,而这条路对凭据问题的答案本来就是 `false` —— 同一件事不必写两遍。
    const stub = httpStub(() => json([]));
    expect(await run(stub, createCoinstatsProvider("solana").validateAccount(ctx({})))).toBe(false);
    expect(stub.calls).toHaveLength(0);
  });

  it("200 → true;401 → false", async () => {
    const ok = httpStub(() => json([]));
    expect(await run(ok, createCoinstatsProvider("solana").validateAccount(ctx()))).toBe(true);
    const denied = httpStub(() => json({}, { status: 401 }));
    expect(await run(denied, createCoinstatsProvider("solana").validateAccount(ctx()))).toBe(false);
  });

  it("够不到上游 → 走错误通道,不压成 false", async () => {
    const stub = httpStub(() => json({}, { status: 503 }));
    expect(
      (await failing(stub, createCoinstatsProvider("solana").validateAccount(ctx())))._tag,
    ).toBe("ConnectorUnavailableError");
  });
});

// account.creds 校验闸(app 分派桥取数前会跑;三链共享此声明,格式交 API 判定 → 仅非空)。
describe("account.creds 校验闸", () => {
  it("接受非空地址(trim 后)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: ADDR })).resolves.toEqual({
      address: ADDR,
    });
  });

  it("拒空 / 缺失地址(→ 桥里即快速非重试失败)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: "  " })).rejects.toThrow(
      /address/,
    );
    await expect(validateCredentials(coinstatsAccountCreds, {})).rejects.toThrow(/address/);
  });
});
