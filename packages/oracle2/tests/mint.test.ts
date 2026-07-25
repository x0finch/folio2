import { describe, expect, it } from "vitest";
import { type CandidateSource, createOracleFor, type SymbolCandidate } from "../src";
import { createMint } from "../src/mint";
import { fakeCacheStore, fakeCgkRefStore, fakeSource, fakeTokenStore } from "./fakes";

const USDC_ETH = "evm:1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "evm:42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_SOL = "solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CGK_USDC = "coingecko/usd-coin";

const seed = (symbol: string, name?: string, logo?: string) => ({ symbol, name, logo });

// 候选源:mint 的 symbol 那一档。真实现从 warm blob 里筛(见 cache.ts),这里直接给。
const candidatesOf = (map: Record<string, SymbolCandidate[]>): CandidateSource => ({
  async bySymbol(symbol) {
    return map[symbol] ?? [];
  },
});

function setup(opts?: {
  cgk?: Record<string, string>;
  candidates?: Record<string, SymbolCandidate[]>;
  overrides?: Record<string, string>;
}) {
  const store = fakeTokenStore();
  const cgkRefs = fakeCgkRefStore(opts?.cgk);
  const mint = createMint({
    store,
    cgkRefs,
    candidates: candidatesOf(opts?.candidates ?? {}),
    overrides: opts?.overrides,
  });
  return { store, cgkRefs, mint };
}

describe("三条路径", () => {
  it("① 命中 `token_refs` —— 纯本地一次点查,不碰 cgk_refs", async () => {
    const { store, cgkRefs, mint } = setup({ cgk: { [USDC_ETH]: "usd-coin" } });
    const first = await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }]);
    const id = first.get(USDC_ETH);

    // 第一次已经把 coingecko 那条 ref 挂上了 → 第二次直接返回,cgk_refs 一次都不查。
    let lookups = 0;
    const counting = {
      ...cgkRefs,
      lookup: (r: readonly string[]) => (lookups++, cgkRefs.lookup(r)),
    };
    const mint2 = createMint({ store, cgkRefs: counting, candidates: candidatesOf({}) });

    expect((await mint2.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH)).toBe(id);
    expect(lookups).toBe(0);
  });

  it("② 经 cgk_refs 归一到已有 Token —— 只加一条 ref,不建行", async () => {
    const { store, mint } = setup({
      cgk: { [USDC_ETH]: "usd-coin", [USDC_ARB]: "usd-coin" },
    });
    const a = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    const b = (await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB);

    expect(b).toBe(a);
    expect(store.rows.size).toBe(1); // 一个 Token
    expect(store.refs.size).toBe(3); // 三条 ref:两条链 + 一条 coingecko
  });

  it("③ cgk_refs 也没有 —— 只写 provider 那条 ref,行照建", async () => {
    const { store, mint } = setup();
    const id = (await mint.of([{ ref: "evm:1/0xdead", seed: seed("WAT") }])).get("evm:1/0xdead");

    expect(id).toBeDefined();
    expect(store.refs.size).toBe(1); // 没有 coingecko 那条
    expect([...store.refs.keys()]).toEqual(["evm:1/0xdead"]);
  });
});

describe("多链归一", () => {
  it("同一个币的三条链 ref 指向同一个 Token", async () => {
    const { store, mint } = setup({
      cgk: { [USDC_ETH]: "usd-coin", [USDC_ARB]: "usd-coin", [USDC_SOL]: "usd-coin" },
    });
    const got = await mint.of([
      { ref: USDC_ETH, seed: seed("USDC") },
      { ref: USDC_ARB, seed: seed("USDC") },
      { ref: USDC_SOL, seed: seed("USDC") },
    ]);

    expect(new Set(got.values()).size).toBe(1);
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(CGK_USDC)).toBe(got.get(USDC_ETH));
  });
});

describe("事后认出来 → 合并", () => {
  it("ref 改指、历史快照 token_id 改指、旧行删除,金额不变", async () => {
    // 第一轮:cgk_refs 还没收录 Arbitrum 那个地址 → 各自独立建行。
    const { store, cgkRefs, mint } = setup({ cgk: { [USDC_ETH]: "usd-coin" } });
    const good = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    const orphan = (
      await mint.of([{ ref: USDC_ARB, seed: seed("USDC", "USD Coin", "arb.png") }])
    ).get(USDC_ARB);
    expect(orphan).not.toBe(good);
    expect(store.rows.size).toBe(2);

    // 那一轮写下的历史快照行指着孤儿。
    store.snapshotTokenIds.push(orphan as string, orphan as string, good as string);

    // 第二轮:cron 刷完表,本地认出来了。
    cgkRefs.map.set(USDC_ARB, "usd-coin");
    const after = (await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB);

    expect(after).toBe(good);
    expect(store.rows.size).toBe(1); // 旧行删了
    expect(store.rows.has(orphan as string)).toBe(false);
    expect(store.refs.get(USDC_ARB)).toBe(good); // ref 改指
    // 历史行一并改指 —— 不改的话曲线会在合并这一刻断成两段。
    expect(store.snapshotTokenIds).toEqual([good, good, good]);
    // 旧行的 provider 图不随行一起丢(回退链的一档)。
    expect(store.rows.get(good as string)?.providerLogo).toBe("arb.png");
  });

  it("没人占着那个币 → 就地补上 coingecko 那条 ref,行不动", async () => {
    const { store, cgkRefs, mint } = setup();
    const id = (await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB);

    cgkRefs.map.set(USDC_ARB, "usd-coin");
    expect((await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB)).toBe(id);
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(CGK_USDC)).toBe(id);
  });
});

describe("并发", () => {
  it("同一条 ref 被同时 mint → 幂等,只出一行(upsert-then-read,无 barrier)", async () => {
    const { store, mint } = setup({ cgk: { [USDC_ETH]: "usd-coin" } });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])),
    );

    const ids = new Set(results.map((r) => r.get(USDC_ETH)));
    expect(ids.size).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  it("同一批里重复的 ref 只处理一次", async () => {
    const { store, mint } = setup();
    await mint.of([
      { ref: USDC_ETH, seed: seed("USDC") },
      { ref: USDC_ETH, seed: seed("USDC") },
      { ref: USDC_ETH, seed: seed("USDC") },
    ]);
    expect(store.rows.size).toBe(1);
  });
});

describe("按 symbol 认币(写时定死)", () => {
  it("地址优先于 symbol —— 换序会把假 USDC 并进真 USDC", async () => {
    // 这个地址在 cgk_refs 里是山寨币,symbol 却报成 USDC。地址赢。
    const { store, mint } = setup({
      cgk: { "evm:1/0xfake": "fake-usdc" },
      candidates: { USDC: [{ coinId: "usd-coin", marketCapRank: 6 }] },
    });
    await mint.of([{ ref: "evm:1/0xfake", seed: seed("USDC") }]);
    expect(store.refs.has("coingecko/fake-usdc")).toBe(true);
    expect(store.refs.has(CGK_USDC)).toBe(false);
  });

  it("有把握(top-N 之内)→ 链上 CoinGecko;跨交易所同名币因此并成一行", async () => {
    const { store, mint } = setup({
      candidates: { BTC: [{ coinId: "bitcoin", marketCapRank: 1 }] },
    });
    const got = await mint.of([
      { ref: "binance/BTC", seed: seed("BTC") },
      { ref: "okx/BTC", seed: seed("BTC") },
    ]);
    expect(got.get("binance/BTC")).toBe(got.get("okx/BTC"));
    expect(store.rows.size).toBe(1);
  });

  it("没把握(同名混战)→ 各自独立成行,不链 CoinGecko", async () => {
    const { store, mint } = setup({
      candidates: {
        MOON: [
          { coinId: "moon-a", marketCapRank: 900 },
          { coinId: "moon-b", marketCapRank: 1000 }, // 没碾压 → 不敢认
        ],
      },
    });
    const got = await mint.of([
      { ref: "evm:1/0xmoon1", seed: seed("MOON") },
      { ref: "evm:56/0xmoon2", seed: seed("MOON") },
    ]);

    expect(got.get("evm:1/0xmoon1")).not.toBe(got.get("evm:56/0xmoon2"));
    expect([...store.refs.keys()].some((r) => r.startsWith("coingecko/"))).toBe(false);
  });

  it("策展覆盖表压过市值排名(防山寨撞名)", async () => {
    const { store, mint } = setup({
      overrides: { BTC: "bitcoin" },
      candidates: { BTC: [{ coinId: "scam-btc", marketCapRank: 2 }] },
    });
    await mint.of([{ ref: "binance/BTC", seed: seed("BTC") }]);
    expect(store.refs.has("coingecko/bitcoin")).toBe(true);
  });
});

describe("元信息", () => {
  it("建行用 provider 报的 symbol/name/logo;logo 落备用槽,CoinGecko 那一槽留空", async () => {
    const { store, mint } = setup();
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC", "USD Coin", "p.png") }])).get(
      USDC_ETH,
    );
    expect(store.rows.get(id as string)).toMatchObject({
      symbol: "USDC",
      name: "USD Coin",
      providerLogo: "p.png",
    });
    expect(store.rows.get(id as string)?.logo).toBeUndefined(); // CoinGecko 那一槽留空
  });

  it("归一到已有 Token 时不覆盖它已有的元信息,只填空槽", async () => {
    const { store, mint } = setup({
      cgk: { [USDC_ETH]: "usd-coin", [USDC_ARB]: "usd-coin" },
    });
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC", "USD Coin") }])).get(USDC_ETH);
    // 假装 CoinGecko 后来把好数据填了进来。
    const row = store.rows.get(id as string);
    if (row) {
      row.name = "USD Coin (CoinGecko)";
      row.logo = "cgk.png";
    }

    // 另一条链上同一个币,provider 报的名字更差、还带一张自己的图。
    await mint.of([{ ref: USDC_ARB, seed: seed("USDC", "usdc.e bridged", "arb.png") }]);

    expect(store.rows.get(id as string)).toMatchObject({
      name: "USD Coin (CoinGecko)", // 没被盖
      logo: "cgk.png", // 没被盖
      providerLogo: "arb.png", // 空槽填上了
    });
  });
});

describe("经门面拿到的 mint 与直接组装等价", () => {
  it("oracleFor(userId).mint 的候选来自该用户的 warm blob", async () => {
    const store = fakeTokenStore();
    const cache = fakeCacheStore();
    const cgk = fakeCgkRefStore();
    const source = fakeSource();
    source.markets = [
      {
        ref: "coingecko/bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        price: { unitPrice: 1, marketCapRank: 1, asOf: 0 },
      },
    ];

    const oracle = createOracleFor({
      stores: { tokens: () => store, cache: () => cache, cgkRefs: () => cgk },
      source,
    })("u1");

    // warm 空 → 认不出来。
    await oracle.mint.of([{ ref: "binance/BTC", seed: seed("BTC") }]);
    expect(store.refs.has("coingecko/bitcoin")).toBe(false);

    // 刷完 warm → 同一条 ref 这次认出来了(补链,不再建行)。
    const { refreshWarm } = await import("../src/cache");
    await refreshWarm(cache, source, 50, cache.now);
    await oracle.mint.of([{ ref: "binance/BTC", seed: seed("BTC") }]);
    expect(store.refs.get("coingecko/bitcoin")).toBe(store.refs.get("binance/BTC"));
    expect(store.rows.size).toBe(1);
  });
});
