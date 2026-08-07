import type { Balance, BalanceProvider, ConnectorError } from "@folio/connectors-basic";
import { validateCredentials } from "@folio/connectors-basic";
import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coinstatsAccountCreds, createCoinstatsProvider } from "../src";
import solanaFixture from "./fixtures/solana.json";

// 契约的出口是 Effect(ADR 0035)。把它接回 vitest 的 async 断言:
// `run` 拿成功值;`failing` 拿**错误值本身** —— 不用 `.rejects`,因为 `runPromise` 抛的是包了
// 一层的 `FiberFailure`,`toMatchObject` 看不见里面的 `_tag`。
const run = <A>(effect: Effect.Effect<A, ConnectorError>): Promise<A> => Effect.runPromise(effect);
const failing = (effect: Effect.Effect<unknown, ConnectorError>): Promise<ConnectorError> =>
  Effect.runPromise(Effect.flip(effect));

// 速率闸是进程内状态。桶要清(免得用例间互相排队),**冷却尤其要清** —— 撞过 429 的用例会给后面
// 的用例留下「冷却中」,于是本该 401 的断言拿到 RATE_LIMITED。sleep 换即时,不真等
// (免费档 1.6 次/秒,不换的话这套测试会慢一大截)。
bypassRateLimitsForTests(true);
beforeEach(() => resetRateLimitsForTests());

const SUI = "0xc0ffee254729296a45a3885639AC7E10F9d54979c0ffee254729296a45a38856";

// 新 FetchContext 形状:account.creds(AC:address)+ creds(PC:COINSTATS_API_KEY)。
// PC 现在承载 provider key(旧 globalKeys 退场)。擦除版类型(= 进 registry 后 manifest 暴露形状)。
function ctx(overrides?: { address?: string; creds?: Record<string, string> }) {
  return {
    account: {
      id: "a1",
      label: "Wallet",
      connectorId: "solana",
      creds: { address: overrides?.address ?? "addr" },
    },
    creds: overrides?.creds ?? { COINSTATS_API_KEY: "k" },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("coinstats factory (一个 provider 包 → 多个 connector)", () => {
  it("每个 connectionId 产出 id=coinstats 的 provider,声明 COINSTATS_API_KEY creds", () => {
    for (const cid of ["solana", "sui-wallet", "cosmos"]) {
      const p = createCoinstatsProvider(cid);
      expect(p.id).toBe("coinstats");
      expect(p.creds.map((c) => c.key)).toEqual(["COINSTATS_API_KEY"]);
    }
  });

  it("绑定各自的 connectionId(sui → 'sui-wallet')", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("[]", { status: 200 }));
    const sui: BalanceProvider<Balance> = createCoinstatsProvider("sui-wallet");
    await run(sui.fetchBalances(ctx({ address: SUI })));
    expect(String(spy.mock.calls[0][0])).toContain("connectionId=sui-wallet");
  });
});

describe("coinstats fetchBalances", () => {
  const provider: BalanceProvider<Balance> = createCoinstatsProvider("solana");

  it("sends X-API-KEY and parses balances", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(solanaFixture), { status: 200 }));
    const { balances } = await run(provider.fetchBalances(ctx()));
    expect(balances).toHaveLength(4); // solana fixture 5 条,1 条无 symbol 被跳过
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)["X-API-KEY"]).toBe("k");
  });

  // 地址由 validateCredentials 预校验;provider 只对 provider key 缺失自查(不发请求)。
  it("throws INVALID_CREDENTIALS when the provider key is missing (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await failing(provider.fetchBalances(ctx({ creds: {} })))).toMatchObject({
      _tag: "ConnectorAuthError",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps 429 → RATE_LIMITED and 401 → AUTH_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    expect(await failing(provider.fetchBalances(ctx()))).toMatchObject({
      _tag: "ConnectorRateLimitError",
    });
    resetRateLimitsForTests(); // 上一句那个 429 写下了冷却,不清掉这里会拿到 RATE_LIMITED
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await failing(provider.fetchBalances(ctx()))).toMatchObject({
      _tag: "ConnectorAuthError",
    });
  });
});

describe("coinstats validateAccount", () => {
  const provider: BalanceProvider<Balance> = createCoinstatsProvider("solana");

  it("false when the provider key is missing, without a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await run(provider.validateAccount(ctx({ creds: {} })))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("true on 200, false on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    expect(await run(provider.validateAccount(ctx()))).toBe(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
    expect(await run(provider.validateAccount(ctx()))).toBe(false);
  });
});

// account.creds 校验闸(app 分派桥取数前会跑;三链共享此声明,格式交 API 判定 → 仅非空)。
describe("coinstats account.creds validator gate", () => {
  it("接受非空地址(trim 后)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: SUI })).resolves.toEqual({
      address: SUI,
    });
  });

  it("拒空/缺失地址(→ CredentialValidationError,桥里即快速非重试失败)", async () => {
    await expect(validateCredentials(coinstatsAccountCreds, { address: "  " })).rejects.toThrow(
      /address/,
    );
    await expect(validateCredentials(coinstatsAccountCreds, {})).rejects.toThrow(/address/);
  });
});
