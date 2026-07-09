import type { Balance, BalanceProvider } from "@folio/connectors-basic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChainIds, parsePositions, resetChainIdsCacheForTests, zerionProvider } from "../src";
import chainsFixture from "./fixtures/chains.json";
import expectedBalances from "./fixtures/expected-balances.json";
import positionsFixture from "./fixtures/positions.json";

// fetchBalances 依赖两个 API:positions(持仓)+ /v1/chains/(slug→数字 chainId,eip155 标识用)。
// 三份 fixture 一一对应:positions.json / chains.json(录制的两个真实响应)→ expected-balances.json
// (解析后的结构化期望值,固化在文件里逐一对比,不散写在断言里)。
// 新 Balance 契约:spot 行【无 meta】,defi 行带 meta:{protocol,positionType}。
// JSON 无法表达 undefined → expected fixture 里省略未定义字段(toEqual 视缺键与 undefined 等价)。

const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// zerion provider 实现(manifest 组装归 entry;这里直接测 provider)。
// 用擦除版类型(= 进 registry 后 manifest 暴露的形状),ctx 的 creds 走宽松 map,与旧测一致。
const provider: BalanceProvider<Balance> = zerionProvider;

// 新 FetchContext 形状:account.creds(AC)+ creds(PC,provider key)。
function ctx(overrides?: { address?: string; creds?: Record<string, string> }) {
  return {
    account: {
      id: "a1",
      label: "Wallet",
      connectorId: "evm",
      creds: { address: overrides?.address ?? ADDR },
    },
    creds: overrides?.creds ?? { ZERION_API_KEY: "test-key" },
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
  it("positions + chains → expected-balances(eip155 标准形标识;spot 无 meta、defi 带 meta)", () => {
    const balances = parsePositions(positionsFixture, parseChainIds(chainsFixture));
    expect(balances).toEqual(expectedBalances);
  });

  it("spot 行不含 meta 键(新 schema);defi 行带 meta", () => {
    const balances = parsePositions(positionsFixture, parseChainIds(chainsFixture));
    for (const b of balances) {
      if (b.kind === "spot") expect("meta" in b).toBe(false);
      if (b.kind === "defi") expect(b.meta).toBeDefined();
    }
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

describe("zerion provider.fetchBalances(双 API)", () => {
  it("并行取 positions + chains,输出与 expected-balances 完全一致", async () => {
    const spy = mockZerionApis();
    const balances = await provider.fetchBalances(ctx());
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
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("chains 映射有进程内缓存:第二次 fetchBalances 不再请求 /v1/chains/", async () => {
    const spy = mockZerionApis();
    await provider.fetchBalances(ctx());
    const chainCalls = () =>
      spy.mock.calls.filter((c) => String(c[0]).includes("/v1/chains/")).length;
    expect(chainCalls()).toBe(1);
    await provider.fetchBalances(ctx());
    expect(chainCalls()).toBe(1); // 仍是 1:走缓存
  });

  // provider key 由 app 分派桥从 env 注入;缺失 → INVALID_CREDENTIALS,不发请求。
  it("throws INVALID_CREDENTIALS when the provider key is missing (no request)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(provider.fetchBalances(ctx({ creds: {} }))).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("positions 429 → RATE_LIMITED(可重试,读 Retry-After);401 → AUTH_FAILED", async () => {
    mockZerionApis({
      positions: () => new Response("", { status: 429, headers: { "retry-after": "3" } }),
    });
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 3000,
    });
    vi.restoreAllMocks();
    resetChainIdsCacheForTests();
    mockZerionApis({ positions: () => new Response("", { status: 401 }) });
    await expect(provider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("zerion provider id", () => {
    expect(provider.id).toBe("zerion");
  });
});
