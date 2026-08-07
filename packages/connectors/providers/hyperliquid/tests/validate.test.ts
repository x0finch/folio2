import { noOutbound } from "@folio/client-core/testing";
import {
  type Balance,
  type BalanceProvider,
  type ConnectorError,
  isRetryable,
  type ProviderNeeds,
  validateCredentials,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hyperliquidAccountCreds, hyperliquidProvider } from "../src";

// 契约的出口是 Effect(ADR 0035)。把它接回 vitest 的 async 断言:
// `run` 拿成功值;`failing` 拿**错误值本身** —— 不用 `.rejects`,因为 `runPromise` 抛的是包了
// 一层的 `FiberFailure`,`toMatchObject` 看不见里面的 `_tag`。
const run = <A>(effect: Effect.Effect<A, ConnectorError, ProviderNeeds>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, noOutbound));
const failing = (
  effect: Effect.Effect<unknown, ConnectorError, ProviderNeeds>,
): Promise<ConnectorError> => Effect.runPromise(Effect.provide(Effect.flip(effect), noOutbound));

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 擦除版类型(= 进 registry 后暴露形状),ctx 的 creds 走宽松 map,与其它 provider 测一致。
const provider: BalanceProvider<Balance> = hyperliquidProvider;

// 新 FetchContext 形状:account.creds(AC:address)+ creds(PC,恒空)。
function ctx(address: string) {
  return {
    account: { id: "a1", label: "HL", connectorId: "hyperliquid", creds: { address } },
    creds: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hyperliquidProvider.validateAccount", () => {
  it("returns true when the address probes the info endpoint with 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await run(provider.validateAccount(ctx(ADDR)))).toBe(true);
  });

  // 契约(#240):够不到上游 → 抛 ProviderError,不压成 false(hyperliquid 是公开 info 端点、
  // 仅地址,没有「凭据被拒」这回事 —— 一切失败都是传输类,全抛)。地址格式校验在 validateCredentials。
  it("5xx → 抛 UPSTREAM_ERROR(retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    const err = await failing(provider.validateAccount(ctx(ADDR)));
    expect(err._tag).toBe("ConnectorUnavailableError");
    expect(isRetryable(err)).toBe(true);
  });

  it("429 → 抛 RATE_LIMITED(retryable)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const err = await failing(provider.validateAccount(ctx(ADDR)));
    expect(err._tag).toBe("ConnectorRateLimitError");
  });

  it("网络炸 → 抛 UPSTREAM_ERROR", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const err = await failing(provider.validateAccount(ctx(ADDR)));
    expect(err._tag).toBe("ConnectorUnavailableError");
  });
});

// account.creds 校验闸(app 分派桥取数前会跑;守住脏 address 快速失败,见 sync-deps 桥)。
describe("hyperliquid account.creds validator gate", () => {
  it("接受合法 EVM 地址", async () => {
    await expect(validateCredentials(hyperliquidAccountCreds, { address: ADDR })).resolves.toEqual({
      address: ADDR,
    });
  });

  it("拒非法/缺失地址(→ CredentialValidationError,桥里即快速非重试失败)", async () => {
    await expect(validateCredentials(hyperliquidAccountCreds, { address: "nope" })).rejects.toThrow(
      /address/,
    );
    await expect(validateCredentials(hyperliquidAccountCreds, {})).rejects.toThrow(/address/);
  });
});
