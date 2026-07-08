import type { FetchContext } from "@folio/balances-basic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  entries,
  makeZerion,
  parseChainIds,
  parsePositions,
  resetChainIdsCacheForTests,
} from "../src";
import chainsFixture from "./fixtures/chains.json";
import expectedBalances from "./fixtures/expected-balances.json";
import positionsFixture from "./fixtures/positions.json";

// fetchBalances 依赖两个 API:positions(持仓)+ /v1/chains/(slug→数字 chainId,eip155 标识用)。
// 三份 fixture 一一对应:positions.json / chains.json(录制的两个真实响应)→ expected-balances.json
// (解析后的结构化期望值,固化在文件里逐一对比,不散写在断言里)。
// JSON 无法表达 undefined → expected fixture 里省略未定义字段(toEqual 视缺键与 undefined 等价)。

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// 全局 key 是实例化参数(工厂闭包,ADR 0009)—— 测试用带 key 实例;无 key 情形用 makeZerion()。
const zerion = makeZerion("test-key");

function ctx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_evm", label: "Wallet" },
    creds: { identifier: ADDR },
    ...overrides,
  };
}

// 按 URL 分流的 fetch mock(两 API 并行,各自新 Response —— body 只能读一次)。
function mockZerionApis(opts?: {
  positions?: Response | (() => Response);
  chains?: Response | (() => Response);
}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const mk = (v: Response | (() => Response) | undefined, fallback: () => Response) =>
      typeof v === "function" ? v() : (v ?? fallback());
    if (String(url).includes("/v1/chains/")) {
      return mk(opts?.chains, () => new Response(JSON.stringify(chainsFixture), { status: 200 }));
    }
    return mk(
      opts?.positions,
      () => new Response(JSON.stringify(positionsFixture), { status: 200 }),
    );
  });
}

beforeEach(() => {
  resetChainIdsCacheForTests(); // 链映射有进程内缓存,清掉避免用例顺序耦合
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseChainIds", () => {
  it("maps slug → decimal chainId from the recorded chains response", () => {
    expect(parseChainIds(chainsFixture)).toEqual({
      ethereum: 1,
      base: 8453,
      arbitrum: 42161,
      "binance-smart-chain": 56,
      avalanche: 43114,
      xdai: 100,
    });
  });
});

describe("parsePositions (golden: fixtures in → fixture out)", () => {
  it("positions + chains → expected-balances(与真实 fetchBalances 同口径:eip155 标准形标识)", () => {
    const balances = parsePositions(positionsFixture, parseChainIds(chainsFixture));
    expect(balances).toEqual(expectedBalances);
  });

  it("链映射缺失 → 抛错(失败即不产,绝不产 slug 兜底形)", () => {
    // chainIds 映射里没有某仓位的链 → 无法产规范 eip155 标识 → 抛 UPSTREAM_ERROR(可重试)。
    expect(() => parsePositions(positionsFixture, {})).toThrow(/no chainId/);
  });

  it("excludes hidden/trash (displayable=false) positions", () => {
    const balances = parsePositions(positionsFixture, parseChainIds(chainsFixture));
    expect(balances.find((b) => b.symbol === "SPAM")).toBeUndefined();
  });
});

describe("zerionProvider.fetchBalances(双 API)", () => {
  it("并行取 positions + chains,输出与 expected-balances 完全一致", async () => {
    const spy = mockZerionApis();
    const balances = await zerion.fetchBalances(ctx());
    expect(balances).toEqual(expectedBalances);
    // 两个端点都请求了,且 Basic auth 一致
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(`/v1/wallets/${ADDR}/positions/`))).toBe(true);
    expect(urls.some((u) => u.includes("/v1/chains/"))).toBe(true);
    for (const [, init] of spy.mock.calls) {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Basic ${btoa("test-key:")}`,
      );
    }
  });

  it("chains 端点失败(500)且无缓存 → fetchBalances 硬失败(不写含分叉标识的快照)", async () => {
    mockZerionApis({ chains: () => new Response("", { status: 500 }) });
    await expect(zerion.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("chains 映射有进程内缓存:第二次 fetchBalances 不再请求 /v1/chains/", async () => {
    const spy = mockZerionApis();
    await zerion.fetchBalances(ctx());
    const chainCalls = () =>
      spy.mock.calls.filter((c) => String(c[0]).includes("/v1/chains/")).length;
    expect(chainCalls()).toBe(1);
    await zerion.fetchBalances(ctx());
    expect(chainCalls()).toBe(1); // 仍是 1:走缓存
  });

  // 凭据(地址)由 sync/create 的 validateCredentials 预校验(见 @folio/balances-basic inputs.test);
  // provider 只对【全局 key 未配置】自查(运维问题,非用户输入)→ INVALID_CREDENTIALS,不发请求。
  it("throws INVALID_CREDENTIALS when the global key is missing (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(makeZerion().fetchBalances(ctx())).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("positions 429 → RATE_LIMITED(可重试,读 Retry-After);401 → AUTH_FAILED", async () => {
    mockZerionApis({
      positions: () => new Response("", { status: 429, headers: { "retry-after": "3" } }),
    });
    await expect(zerion.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 3000,
    });
    vi.restoreAllMocks();
    resetChainIdsCacheForTests();
    mockZerionApis({ positions: () => new Response("", { status: 401 }) });
    await expect(zerion.fetchBalances(ctx())).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("entry registers accountType onchain_evm", () => {
    expect(entries.map((e) => e.manifest.accountType)).toContain("onchain_evm");
  });
});
