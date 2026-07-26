import { describe, expect, it } from "vitest";
import { type CandidateSource, createMint, type TokenCandidate } from "../src";
import { fakeRefIndexStore, fakeTokenStore } from "./fakes";

const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_SOL = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SRC_USDC = "src/usd-coin";

const seed = (symbol: string, name?: string, providerLogo?: string) => ({
  symbol,
  name,
  providerLogo,
});

// 候选源:mint 的 symbol 那一档。真实现从 warm rows 里筛(见 cache.ts),这里直接给。
const candidatesOf = (map: Record<string, TokenCandidate[]>): CandidateSource => ({
  async bySymbol(symbol) {
    return map[symbol] ?? [];
  },
});

function setup(opts?: {
  index?: Record<string, string>;
  candidates?: Record<string, TokenCandidate[]>;
  overrides?: Record<string, string>;
}) {
  const store = fakeTokenStore();
  const refIndex = fakeRefIndexStore(opts?.index);
  const mint = createMint({
    store,
    refIndex,
    candidates: candidatesOf(opts?.candidates ?? {}),
    namer: "src",
    overrides: opts?.overrides,
  });
  return { store, refIndex, mint };
}

describe("三条路径", () => {
  it("① 命中本地 ref 行 —— 纯本地一次点查,不碰全局映射", async () => {
    const { store, refIndex, mint } = setup({ index: { [USDC_ETH]: "usd-coin" } });
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);

    const before = refIndex.lookups;
    expect((await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH)).toBe(id);
    expect(refIndex.lookups).toBe(before); // 第二次一次都没查
    expect(store.rows.size).toBe(1);
  });

  it("② 经全局映射归一到已有 Token —— 只加一条 ref,不建行", async () => {
    const { store, mint } = setup({
      index: { [USDC_ETH]: "usd-coin", [USDC_ARB]: "usd-coin" },
    });
    const a = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    const b = (await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB);

    expect(b).toBe(a);
    expect(store.rows.size).toBe(1); // 一个 Token
    expect(store.refs.size).toBe(3); // 三条 ref:两条链 + 一条本源
  });

  it("③ 全局映射也没有 —— 只写 provider 那条 ref,行照建", async () => {
    const { store, mint } = setup();
    const id = (await mint.of([{ ref: "evm:1/contract:0xdead", seed: seed("WAT") }])).get(
      "evm:1/contract:0xdead",
    );

    expect(id).toBeDefined();
    expect([...store.refs.keys()]).toEqual(["evm:1/contract:0xdead"]); // 没有本源那条
    expect(store.rows.get(id as string)?.ref).toBeNull(); // 上游还没认出它
  });
});

describe("多链归一", () => {
  it("同一个币的三条链 ref 指向同一个 Token", async () => {
    const { store, mint } = setup({
      index: { [USDC_ETH]: "usd-coin", [USDC_ARB]: "usd-coin", [USDC_SOL]: "usd-coin" },
    });
    const got = await mint.of([
      { ref: USDC_ETH, seed: seed("USDC") },
      { ref: USDC_ARB, seed: seed("USDC") },
      { ref: USDC_SOL, seed: seed("USDC") },
    ]);

    expect(new Set(got.values()).size).toBe(1);
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(SRC_USDC)).toBe(got.get(USDC_ETH));
  });
});

describe("事后认出来 → 合并", () => {
  it("ref 改指、历史快照 token_id 改指、旧行删除", async () => {
    const { store, refIndex, mint } = setup({ index: { [USDC_ETH]: "usd-coin" } });
    const good = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    const orphan = (
      await mint.of([{ ref: USDC_ARB, seed: seed("USDC", "USD Coin", "arb.png") }])
    ).get(USDC_ARB);
    expect(orphan).not.toBe(good);
    expect(store.rows.size).toBe(2);

    // 那一轮写下的历史快照行指着孤儿。
    store.snapshotTokenIds.push(orphan as string, orphan as string, good as string);

    // 第二轮:cron 刷完表,本地认出来了。
    refIndex.set("src", USDC_ARB, "usd-coin");
    expect((await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB)).toBe(good);

    expect(store.rows.size).toBe(1);
    expect(store.rows.has(orphan as string)).toBe(false);
    expect(store.refs.get(USDC_ARB)).toBe(good); // ref 改指
    // 历史行一并改指 —— 不改的话曲线会在合并这一刻断成两段。
    expect(store.snapshotTokenIds).toEqual([good, good, good]);
    // 旧行的 provider 图不随行一起丢(回退链的一档)。
    expect(store.rows.get(good as string)?.providerLogo).toBe("arb.png");
  });

  it("没人占着那个币 → 就地补上本源那条 ref,行不动", async () => {
    const { store, refIndex, mint } = setup();
    const id = (await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB);

    refIndex.set("src", USDC_ARB, "usd-coin");
    expect((await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB)).toBe(id);
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(SRC_USDC)).toBe(id);
    expect(store.rows.get(id as string)?.ref).toBe(SRC_USDC); // 这下认出来了
  });
});

describe("并发", () => {
  it("同一条 ref 被同时 mint → 幂等,只出一行(upsert-then-read,无 barrier)", async () => {
    const { store, mint } = setup({ index: { [USDC_ETH]: "usd-coin" } });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])),
    );
    expect(new Set(results.map((r) => r.get(USDC_ETH))).size).toBe(1);
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
    const { store, mint } = setup({
      index: { "evm:1/contract:0xfake": "fake-usdc" },
      candidates: { USDC: [{ ref: SRC_USDC, marketCapRank: 6 }] },
    });
    await mint.of([{ ref: "evm:1/contract:0xfake", seed: seed("USDC") }]);
    expect(store.refs.has("src/fake-usdc")).toBe(true);
    expect(store.refs.has(SRC_USDC)).toBe(false);
  });

  // ADR 0020 第三轮:这是**合约不许按 symbol 猜**那条规则的守卫。
  it("映射表没收录的合约 → 绝不按 symbol 并进主流币,哪怕它 symbol 写着 USDC", async () => {
    const { store, mint } = setup({
      // 映射表里查不到它(昨天刚部署),而 symbol 字段自己填成 USDC。
      overrides: { USDC: "usd-coin" },
      candidates: { USDC: [{ ref: SRC_USDC, marketCapRank: 6 }] },
    });
    // 先让真 USDC 在库里(以太坊那条已被收录)。
    const { mint: mint2, store: store2 } = setup({
      index: { [USDC_ETH]: "usd-coin" },
      overrides: { USDC: "usd-coin" },
    });
    const real = (await mint2.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    expect(store2.refs.get(SRC_USDC)).toBe(real);

    const scam = (await mint.of([{ ref: "evm:1/contract:0xdead", seed: seed("USDC") }])).get(
      "evm:1/contract:0xdead",
    );
    expect(scam).toBeDefined();
    // 自己一行、不链上游 —— 于是拿不到真 USDC 的价,也不会污染那一行的总枚数。
    expect(store.rows.get(scam as string)?.ref).toBeNull();
    expect(store.refs.has(SRC_USDC)).toBe(false);
  });

  it("原生币仍然按 symbol 认 —— 它们按设计不进映射表,那是唯一的一条路", async () => {
    const { store, mint } = setup({ overrides: { BTC: "bitcoin" } });
    const id = (await mint.of([{ ref: "bitcoin/native", seed: seed("BTC") }])).get(
      "bitcoin/native",
    );
    expect(store.refs.get("src/bitcoin")).toBe(id);
  });

  it("有把握(top-N 之内)→ 链上上游;跨交易所同名币因此并成一行", async () => {
    const { store, mint } = setup({
      candidates: { BTC: [{ ref: "src/bitcoin", marketCapRank: 1 }] },
    });
    const got = await mint.of([
      { ref: "binance/BTC", seed: seed("BTC") },
      { ref: "okx/BTC", seed: seed("BTC") },
    ]);
    expect(got.get("binance/BTC")).toBe(got.get("okx/BTC"));
    expect(store.rows.size).toBe(1);
  });

  it("没把握(同名混战)→ 各自独立成行,不链上游", async () => {
    const { store, mint } = setup({
      candidates: {
        MOON: [
          { ref: "src/moon-a", marketCapRank: 900 },
          { ref: "src/moon-b", marketCapRank: 1000 }, // 没碾压 → 不敢认
        ],
      },
    });
    const got = await mint.of([
      { ref: "evm:1/contract:0xmoon1", seed: seed("MOON") },
      { ref: "evm:56/contract:0xmoon2", seed: seed("MOON") },
    ]);
    expect(got.get("evm:1/contract:0xmoon1")).not.toBe(got.get("evm:56/contract:0xmoon2"));
    expect([...store.refs.keys()].some((r) => r.startsWith("src/"))).toBe(false);
  });

  it("策展覆盖表压过市值排名(防山寨撞名);它由 adapter 提供,值是上游 id", async () => {
    const { store, mint } = setup({
      overrides: { BTC: "bitcoin" },
      candidates: { BTC: [{ ref: "src/scam-btc", marketCapRank: 2 }] },
    });
    await mint.of([{ ref: "binance/BTC", seed: seed("BTC") }]);
    expect(store.refs.has("src/bitcoin")).toBe(true);
  });
});

describe("元信息", () => {
  it("建行用 provider 报的 symbol/name/logo;图落备用槽,源那一槽留空", async () => {
    const { store, mint } = setup();
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC", "USD Coin", "p.png") }])).get(
      USDC_ETH,
    );
    expect(store.rows.get(id as string)).toMatchObject({
      symbol: "USDC",
      name: "USD Coin",
      providerLogo: "p.png",
    });
    expect(store.rows.get(id as string)?.logo).toBeUndefined();
  });

  it("归一到已有 Token 时不覆盖它已有的元信息,只填空槽", async () => {
    const { store, mint } = setup({ index: { [USDC_ETH]: "usd-coin", [USDC_ARB]: "usd-coin" } });
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC", "USD Coin") }])).get(USDC_ETH);
    // 假装上游后来把好数据填了进来。
    const row = store.rows.get(id as string);
    if (row) {
      row.name = "USD Coin (upstream)";
      row.logo = "up.png";
    }

    await mint.of([{ ref: USDC_ARB, seed: seed("USDC", "usdc.e bridged", "arb.png") }]);

    expect(store.rows.get(id as string)).toMatchObject({
      name: "USD Coin (upstream)", // 没被盖
      logo: "up.png", // 没被盖
      providerLogo: "arb.png", // 空槽填上了
    });
  });
});

describe("读不懂的 ref", () => {
  it("不按 symbol 猜 —— 关于它我们什么都不知道", async () => {
    const { store, mint } = setup({
      overrides: { USDC: "usd-coin" },
      candidates: { USDC: [{ ref: SRC_USDC, marketCapRank: 6 }] },
    });
    const id = (await mint.of([{ ref: "nonsense", seed: seed("USDC") }])).get("nonsense");
    expect(id).toBeDefined(); // 行照建(快照要有 token_id),但不链上游
    expect(store.rows.get(id as string)?.ref).toBeNull();
    expect(store.refs.has(SRC_USDC)).toBe(false);
  });
});
