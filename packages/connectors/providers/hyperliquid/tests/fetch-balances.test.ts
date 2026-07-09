import type { Balance, BalanceProvider } from "@folio/connectors-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hyperliquidProvider, parseClearinghouseState } from "../src";
import fixture from "./fixtures/clearinghouse-state.json";
import expected from "./fixtures/expected-balances.json";

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 擦除版类型(= 进 registry 后 manifest 暴露的形状),ctx 的 creds 走宽松 map,与其它 provider 测一致。
const provider: BalanceProvider<Balance> = hyperliquidProvider;

// 新 FetchContext 形状:account.creds(AC:identifier)+ creds(PC,hyperliquid 恒空)。
function ctx(overrides?: { identifier?: string }) {
  return {
    account: {
      id: "a1",
      label: "HL",
      connectorId: "hyperliquid",
      creds: { identifier: overrides?.identifier ?? ADDR },
    },
    creds: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// 两份 fixture 一一对应:clearinghouse-state.json(schema 忠实的响应,基于官方示例 + 一条空头)→
// expected-balances.json(解析后的期望值,固化逐一对比)。覆盖:权益行 kind:"perp_equity"(唯一带值)
// + 每仓位一行 kind:"perp_position"(value=0、明细进 meta、无 role);字符串字段统一 Number();
// szi 符号→side(long/short);liquidationPx 可为 null。expected 是对旧 golden 的手工变换(改 kind + 删 role)。
describe("parseClearinghouseState (golden: fixture in → fixture out)", () => {
  it("maps the recorded response to expected-balances (kind-split, no role)", () => {
    expect(parseClearinghouseState(fixture)).toEqual(expected);
  });

  it("emits only the perp_equity row for an account with no open positions", () => {
    const balances = parseClearinghouseState({
      marginSummary: {
        accountValue: "0.0",
        totalMarginUsed: "0.0",
        totalNtlPos: "0.0",
        totalRawUsd: "0.0",
      },
      assetPositions: [],
      withdrawable: "0.0",
    });
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ symbol: "USDC", amount: 0, value: 0, kind: "perp_equity" });
  });

  it("total value equals account equity (positions do not double-count)", () => {
    const total = parseClearinghouseState(fixture).reduce((s, b) => s + b.value, 0);
    expect(total).toBe(13109.482328);
  });
});

describe("hyperliquidProvider.fetchBalances", () => {
  it("POSTs clearinghouseState with the address and parses the response", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    const balances = await provider.fetchBalances(ctx());
    expect(balances).toHaveLength(3);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/info");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ type: "clearinghouseState", user: ADDR });
  });

  // 地址格式校验已上移到 sync/create 的 validateCredentials(见 @folio/connectors-basic);
  // hyperliquid 无全局/provider key,provider 本身不再预检 creds → 此处不测"无请求即拒"。

  it("maps 429 → RATE_LIMITED (retryable, parses Retry-After), 5xx → UPSTREAM_ERROR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
    );
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 3000,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("throws PARSE_ERROR on invalid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });

  it("hyperliquid provider id + empty PC creds", () => {
    expect(provider.id).toBe("hyperliquid");
    expect(provider.creds).toEqual([]);
  });
});
