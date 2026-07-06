import { type FetchContext, validateCredentials } from "@folio/balances-basic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addressToBalances, bitcoinProvider, providers } from "../src";
import addressFixture from "./fixtures/address.json";
import expectedBalances from "./fixtures/expected-balances.json";

// fetchBalances(阶段 1 单地址)依赖一个 API:Esplora /address/:addr(一次得已确认 + 未确认 + used)。
// 录制响应 address.json → 解析后期望 expected-balances.json(固化对比,不散写断言)。
// JSON 无法表达 undefined → expected 省略未定义字段(toEqual 视缺键与 undefined 等价)。

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

function ctx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    account: { id: "a1", userId: "u1", type: "onchain_bitcoin", label: "Cold" },
    creds: { identifier: ADDR },
    globalKeys: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addressToBalances (golden: fixture in → fixture out)", () => {
  it("已确认净额→amount(BTC),未确认净额→meta.pendingSats,value=0 交给 revalue", () => {
    expect(addressToBalances(addressFixture)).toEqual(expectedBalances);
  });

  it("无已确认且无未确认 → 空(不产 0 行)", () => {
    const empty = { chain_stats: {}, mempool_stats: {} };
    expect(addressToBalances(empty)).toEqual([]);
  });

  it("仅未确认(confirmed=0,pending>0)→ 产 0-amount BTC 行 + pending 徽标", () => {
    const pendingOnly = { chain_stats: {}, mempool_stats: { funded_txo_sum: 700000 } };
    const out = addressToBalances(pendingOnly);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(0);
    expect((out[0].meta as { pendingSats: number }).pendingSats).toBe(700000);
  });
});

describe("bitcoinProvider.fetchBalances", () => {
  it("打 Esplora 地址端点(带 UA),输出与 expected-balances 一致", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(addressFixture), { status: 200 }));
    const balances = await bitcoinProvider.fetchBalances(ctx());
    expect(balances).toEqual(expectedBalances);
    expect(String(spy.mock.calls[0][0])).toContain(`/address/${ADDR}`);
    expect((spy.mock.calls[0][1]?.headers as Record<string, string>)["user-agent"]).toBeTruthy();
  });

  it("默认走公共 mempool.space Esplora", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(addressFixture), { status: 200 }));
    await bitcoinProvider.fetchBalances(ctx());
    expect(String(spy.mock.calls[0][0])).toContain("https://mempool.space/api");
  });

  it("globalKeys[BITCOIN_ESPLORA_BASE] 覆写 → 走自托管节点", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(addressFixture), { status: 200 }));
    await bitcoinProvider.fetchBalances(
      ctx({ globalKeys: { BITCOIN_ESPLORA_BASE: "https://node.local/api" } }),
    );
    expect(String(spy.mock.calls[0][0])).toContain("https://node.local/api");
  });

  it("429 → RATE_LIMITED(可重试,读 Retry-After)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "5" } }),
    );
    await expect(bitcoinProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 5000,
    });
  });

  it("500 → UPSTREAM_ERROR(可重试)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(bitcoinProvider.fetchBalances(ctx())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("serves accountType onchain_bitcoin and is exported in providers", () => {
    expect(bitcoinProvider.accountType).toBe("onchain_bitcoin");
    expect(providers).toContain(bitcoinProvider);
  });
});

describe("bitcoinProvider.fetchBalances — xpub 模式(gap 扫描)", () => {
  // XPUB84 native 首外部地址(BIP84 向量);其它派生地址视为空 → gap 达标即停。
  const XPUB84 =
    "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
  const FIRST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
  const empty = () =>
    new Response(JSON.stringify({ chain_stats: {}, mempool_stats: {} }), { status: 200 });

  it("单脚本派生 → 汇总已确认净额;连续未用达 gap 即停", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes(FIRST)) {
        return new Response(
          JSON.stringify({
            chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0, funded_txo_count: 1 },
            mempool_stats: {},
          }),
          { status: 200 },
        );
      }
      return empty();
    });
    const balances = await bitcoinProvider.fetchBalances(
      ctx({ creds: { identifier: XPUB84, scriptType: "native" } }),
    );
    expect(balances).toHaveLength(1);
    expect(balances[0].amount).toBe(0.001); // 100000 sats
    expect((balances[0].meta as { truncated?: boolean }).truncated).toBeFalsy();
    // 两链各扫到 gap(20)截止:1 个已用 + 20 空(外链)+ 20 空(找零)≈ 41 次
    expect(spy.mock.calls.length).toBeLessThan(60);
  });

  it("产分布(仅非零)+ 收款指引(lastUsed + 其后两个未用外部地址)", async () => {
    const RECV0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"; // 外部 0/0
    const RECV1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"; // 外部 0/1
    const CHANGE0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"; // 找零 1/0
    const funded = (sats: number) =>
      new Response(
        JSON.stringify({
          chain_stats: { funded_txo_sum: sats, spent_txo_sum: 0, funded_txo_count: 1 },
          mempool_stats: {},
        }),
        { status: 200 },
      );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes(RECV0)) return funded(50000);
      if (u.includes(CHANGE0)) return funded(30000);
      return empty();
    });
    const balances = await bitcoinProvider.fetchBalances(
      ctx({ creds: { identifier: XPUB84, scriptType: "native" } }),
    );
    const meta = balances[0].meta as {
      addresses: { address: string; chain: string; balanceSats: number }[];
      receive: { lastUsed: { index: number; address: string }; next: { index: number }[] };
    };
    expect(balances[0].amount).toBe(0.0008); // 80000 sats
    // 分布仅非零:外部 0/0(收款)+ 找零 1/0
    expect(meta.addresses.map((a) => a.address).sort()).toEqual([CHANGE0, RECV0].sort());
    expect(meta.addresses.find((a) => a.address === CHANGE0)?.chain).toBe("change");
    // 收款指引:lastUsed = 外部 0/0;next = 0/1 + 0/2
    expect(meta.receive.lastUsed).toEqual({ index: 0, address: RECV0 });
    expect(meta.receive.next[0]).toEqual({ index: 1, address: RECV1 });
    expect(meta.receive.next).toHaveLength(2);
    expect(meta.receive.next[1].index).toBe(2);
  });

  it("全用满 → 超地址硬上限提前停并标 truncated", async () => {
    // 每次返回新 Response(body 只能读一次)。
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            chain_stats: { funded_txo_sum: 1000, spent_txo_sum: 0, funded_txo_count: 1 },
            mempool_stats: {},
          }),
          { status: 200 },
        ),
    );
    const balances = await bitcoinProvider.fetchBalances(
      ctx({ creds: { identifier: XPUB84, scriptType: "native" } }),
    );
    expect((balances[0].meta as { truncated?: boolean }).truncated).toBe(true);
  });
});

describe("identifier 校验(provider.inputs 的 validator)", () => {
  const accept = async (id: string, extra: Record<string, string> = {}) =>
    validateCredentials(bitcoinProvider.inputs ?? [], { identifier: id, ...extra });
  const reject = (id: string) => expect(accept(id)).rejects.toThrow(/identifier/);

  it("接受 P2PKH / P2SH / bech32 / taproot 地址 + xpub/ypub/zpub", async () => {
    await expect(accept("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).resolves.toBeDefined(); // P2PKH
    await expect(accept("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).resolves.toBeDefined(); // P2SH
    await expect(accept("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).resolves.toBeDefined(); // bech32
    await expect(
      accept("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"),
    ).resolves.toBeDefined(); // taproot
    await expect(
      accept(
        "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAU3",
      ),
    ).resolves.toBeDefined(); // xpub
  });

  it("scriptType 接受枚举值、省略时可选", async () => {
    await expect(
      accept("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", { scriptType: "taproot" }),
    ).resolves.toBeDefined();
    await expect(
      validateCredentials(bitcoinProvider.inputs ?? [], {
        identifier: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      }),
    ).resolves.toBeDefined(); // scriptType 省略 OK
  });

  it("拒绝 EVM 0x / 乱串", async () => {
    await reject("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    await reject("not-an-address");
  });
});
