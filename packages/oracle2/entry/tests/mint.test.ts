import { RESOLUTION_TOP_RANK } from "@folio/oracle2-basic";
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
// **记调用次数** —— 「有没有走到 symbol 这一档」本身就是断言对象:#210 的闸在合约上会提前返回,
// 不记次数的话,一条本想验证判官的用例会因为压根没走到判官而绿掉(空转)。
interface RecordingCandidates extends CandidateSource {
  asked: string[];
}
const candidatesOf = (map: Record<string, TokenCandidate[]>): RecordingCandidates => {
  const asked: string[] = [];
  return {
    asked,
    async bySymbol(symbol) {
      asked.push(symbol);
      return map[symbol] ?? [];
    },
  };
};

function setup(opts?: {
  index?: Record<string, string>;
  candidates?: Record<string, TokenCandidate[]>;
  overrides?: Record<string, string>;
}) {
  const store = fakeTokenStore();
  const refIndex = fakeRefIndexStore(opts?.index);
  const candidates = candidatesOf(opts?.candidates ?? {});
  const mint = createMint({
    store,
    refIndex,
    candidates,
    namer: "src",
    overrides: opts?.overrides,
  });
  return { store, refIndex, candidates, mint };
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

// 上游还不认识的新币,同时从链上和交易所进来。**两条 ref 失败的原因不同,后来被认出来的路径也不同**:
//   · 链上合约 → 靠全局映射表,cron 刷到就认出来
//   · 交易所代号 → 只能靠 symbol,而候选恒是 **warm(市值前 N 名)** 的子集(见 cache.ts)
// 于是有一段中间状态:「上游收录了」并不等于「两行会并成一行」——那要等它进榜。
// 上面那组合并用例两边都是合约形,盖不到这条分岔,所以单开一组。
const XXA_ETH = "evm:1/contract:0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";
const XXA_CEX = "binance/XXA";
const XXA_ID = "xxa-token"; // 上游对它的叫法(映射表的 local_name)
const SRC_XXA = `src/${XXA_ID}`; // 拼成 ref 之后的样子 = 锚

describe("新币:链上 + 交易所,上游后来才收录", () => {
  // 第一轮:上游还没收录 → 两条 ref 都认不出来,各自成行。
  // candidateMap 由调用方持有 → 测试中途往里塞就等于「这个币进榜了」。
  async function firstRound(candidateMap: Record<string, TokenCandidate[]> = {}) {
    const ctx = setup({ candidates: candidateMap });
    const ids = await ctx.mint.of([
      { ref: XXA_ETH, seed: seed("XXA") },
      { ref: XXA_CEX, seed: seed("XXA") },
    ]);
    return { ...ctx, onchain: ids.get(XXA_ETH) as string, cex: ids.get(XXA_CEX) as string };
  }

  const bothRefs = [
    { ref: XXA_ETH, seed: seed("XXA") },
    { ref: XXA_CEX, seed: seed("XXA") },
  ];

  it("上游还没收录 → 两行同名代币,各自独立、都没有价", async () => {
    const { store, candidates, onchain, cex } = await firstRound();
    expect(onchain).not.toBe(cex);
    expect(store.rows.size).toBe(2);
    for (const id of [onchain, cex]) {
      expect(store.rows.get(id)?.symbol).toBe("XXA");
      expect(store.rows.get(id)?.ref).toBeNull(); // 没有本源那条 ref → 问不到价
    }
    // 两条失败的原因不同:合约形一次都没问判官(闸在上游),交易所那条问了、但候选为空。
    expect(candidates.asked).toEqual(["XXA"]);
  });

  it("上游收录了合约但还没进榜 → 只有链上那行认出来,**仍是两行**", async () => {
    const { store, refIndex, mint, onchain, cex } = await firstRound();
    refIndex.set("src", XXA_ETH, XXA_ID); // cron 刷到了这个合约

    const ids = await mint.of(bothRefs);
    // 链上那行就地补上本源那条 ref:行不动、历史不动,从此有价有图。
    expect(ids.get(XXA_ETH)).toBe(onchain);
    expect(store.rows.get(onchain)?.ref).toBe(SRC_XXA);
    // 交易所那行只能靠 symbol,而它还不在 warm 里 → 原样不动,继续是没有价的第二行。
    expect(ids.get(XXA_CEX)).toBe(cex);
    expect(store.rows.get(cex)?.ref).toBeNull();
    expect(store.rows.size).toBe(2);
  });

  it("再进了市值 100 名 → 两行合并成一行(**单候选那一档,不看排名**)", async () => {
    const warm: Record<string, TokenCandidate[]> = {};
    const { store, refIndex, mint, onchain, cex } = await firstRound(warm);
    refIndex.set("src", XXA_ETH, XXA_ID);
    // 头两轮写下的历史快照行分别指着两个 id。
    store.snapshotTokenIds.push(onchain, cex);

    warm.XXA = [{ ref: SRC_XXA, marketCapRank: 100 }]; // 进榜了

    const ids = await mint.of(bothRefs);
    // 哪一行活下来取决于批内顺序(先认出来的那条先占住上游 ref),无所谓 —— 要的是两条 ref 同归一行。
    const merged = ids.get(XXA_CEX);
    expect(ids.get(XXA_ETH)).toBe(merged);
    expect(store.rows.size).toBe(1);
    // 历史行一并改指 —— 不改的话曲线会在合并这一刻断成两段。
    expect(store.snapshotTokenIds).toEqual([merged, merged]);

    // **100 名在 top-50 之外**:它能过是因为同名只此一个(单候选),不是因为排名够高。
    // 换言之这一档是脆的 —— 哪天再来一个 symbol 也叫 XXA 的币进了榜,判官会判「没把握」,
    // 于是交易所那行又掉回独立一行(下一条用例)。
    expect(RESOLUTION_TOP_RANK).toBeLessThan(100);
  });

  it("同名的第二个币也进了榜 → 100 名碾压不了它 → 交易所那行留在原地", async () => {
    const warm: Record<string, TokenCandidate[]> = {};
    const { store, refIndex, mint, onchain, cex } = await firstRound(warm);
    refIndex.set("src", XXA_ETH, XXA_ID);
    // 两个候选:100 名 vs 300 名。300 / 100 = 3 倍 < 碾压线 → 判「没把握」。
    warm.XXA = [
      { ref: SRC_XXA, marketCapRank: 100 },
      { ref: "src/xxa-imposter", marketCapRank: 300 },
    ];

    const ids = await mint.of(bothRefs);
    expect(ids.get(XXA_ETH)).toBe(onchain); // 链上那条走地址,不受同名混战影响
    expect(ids.get(XXA_CEX)).toBe(cex); // 交易所那条认不出来 → 仍是没有价的第二行
    expect(store.rows.size).toBe(2);
  });
});

// 同一个币,链上侧按**地址**认、交易所侧按**symbol** 认 —— 两条判据互不相干,所以链上合约里写的
// symbol 与上游实际叫法不一致时(MATIC 改名 POL 之后,合约里那份还是旧名),两侧仍然归到同一行。
// 认定是对的,错的只是显示名 —— 修它是 `refreshStaleInfo` 的活(见 tokens.test.ts 那组覆盖用例)。
const POL_ETH = "evm:1/contract:0x455e53cbb86018ac2b8092fdcd39d8444affc3f6";
const POL_CEX = "binance/POL";
const POL_ID = "polygon-ecosystem-token";
const SRC_POL = `src/${POL_ID}`;

describe("链上 symbol 与上游叫法不一致", () => {
  it("链上报旧名、交易所报新名 → 仍归到同一行(两条判据互不相干)", async () => {
    const { store, mint } = setup({
      index: { [POL_ETH]: POL_ID }, // 链上那条:按地址认,压根不看 symbol
      candidates: { POL: [{ ref: SRC_POL, marketCapRank: 76 }] }, // 交易所那条:按 symbol 认
    });

    const ids = await mint.of([
      { ref: POL_ETH, seed: seed("MATIC", "Matic Network") }, // 合约里写的是旧名
      { ref: POL_CEX, seed: seed("POL") }, // 交易所报的是新名
    ]);

    expect(ids.get(POL_CEX)).toBe(ids.get(POL_ETH));
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(SRC_POL)).toBe(ids.get(POL_ETH));
  });

  it("行上留着的是**先到者**报的名字 —— 所以必须由上游覆盖一遍", async () => {
    const { store, candidates, mint } = setup({
      index: { [POL_ETH]: POL_ID },
      candidates: { POL: [{ ref: SRC_POL, marketCapRank: 76 }] },
    });

    const id = (await mint.of([{ ref: POL_ETH, seed: seed("MATIC", "Matic Network") }])).get(
      POL_ETH,
    ) as string;
    // 链上那条一次都没问判官 —— 它按地址就认出来了,symbol 是什么无关。
    expect(candidates.asked).toEqual([]);

    // 建行用的是合约里那份旧名:mint 不修显示名(它只管认身份,而且不出网)。
    expect(store.rows.get(id)).toMatchObject({ symbol: "MATIC", name: "Matic Network" });
    // 后来交易所那条进来,归到同一行 —— 名字还是旧的,与哪个账户先同步有关。
    expect((await mint.of([{ ref: POL_CEX, seed: seed("POL") }])).get(POL_CEX)).toBe(id);
    expect(store.rows.get(id)?.symbol).toBe("MATIC");
    // 修它归 refreshStaleInfo(读路径、能出网)—— 建行时 infoStale 就是 true,等着被刷。
    expect(store.rows.get(id)?.infoStale).toBe(true);
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
    const { store, candidates, mint } = setup({
      candidates: { BTC: [{ ref: "src/bitcoin", marketCapRank: 1 }] },
    });
    const got = await mint.of([
      { ref: "binance/BTC", seed: seed("BTC") },
      { ref: "okx/BTC", seed: seed("BTC") },
    ]);
    expect(got.get("binance/BTC")).toBe(got.get("okx/BTC"));
    expect(store.rows.size).toBe(1);
    expect(candidates.asked).toContain("BTC"); // 确实走到了判官,不是空转
  });

  // 判官本身的分支在 confidence.test.ts 里逐条测;这里只验「不认」如何传导到落库形状。
  // 用**场馆命名**的 ref:合约会被闸提前挡掉,压根走不到判官 —— 那样这条用例就是空转的。
  it("没把握(同名混战)→ 各自独立成行,不链上游", async () => {
    const { store, candidates, mint } = setup({
      candidates: {
        MOON: [
          { ref: "src/moon-a", marketCapRank: 900 },
          { ref: "src/moon-b", marketCapRank: 1000 }, // 没碾压 → 不敢认
        ],
      },
    });
    const got = await mint.of([
      { ref: "binance/MOON", seed: seed("MOON") },
      { ref: "okx/MOON", seed: seed("MOON") },
    ]);
    expect(candidates.asked).toEqual(["MOON", "MOON"]); // 两条都问过判官
    expect(got.get("binance/MOON")).not.toBe(got.get("okx/MOON"));
    expect([...store.refs.keys()].some((r) => r.startsWith("src/"))).toBe(false);
  });

  // 反过来的证明:闸挡掉的合约根本不问判官 —— 这是「假 USDC 不会并进真 USDC」的机制本身。
  it("合约形的 ref 一次都不问判官(闸在上游)", async () => {
    const { candidates, mint } = setup({
      candidates: { MOON: [{ ref: "src/moon-a", marketCapRank: 1 }] }, // 会被认的候选
    });
    await mint.of([{ ref: "evm:1/contract:0xmoon1", seed: seed("MOON") }]);
    expect(candidates.asked).toEqual([]);
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

// —— 七个 producer 的实际输出各走一遍 ——
// 前面那些测试是按「决策树的分支」组织的;这一组按**来源**组织,确保每个 producer 真实吐出的
// ref 形状都能落到对的 token 上。形状取自各 provider 的 golden fixture。
describe("各来源的 ref 都落到对的 token", () => {
  const USDC_ADDR = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const USDC_SOL_ADDR = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  // 一份「什么都齐」的环境:映射表收录了两条链上的 USDC,warm 里有 USDC / ETH / BTC / SOL。
  const fullSetup = () =>
    setup({
      index: { [USDC_ADDR]: "usd-coin", [USDC_SOL_ADDR]: "usd-coin" },
      candidates: {
        USDC: [{ ref: SRC_USDC, marketCapRank: 6 }],
        ETH: [{ ref: "src/ethereum", marketCapRank: 2 }],
        BTC: [{ ref: "src/bitcoin", marketCapRank: 1 }],
        SOL: [{ ref: "src/solana", marketCapRank: 5 }],
      },
    });

  it("六个来源的 USDC 归到同一个 Token(链上合约 / 交易所 / perp / 手记选币)", async () => {
    const { store, mint } = fullSetup();
    const got = await mint.of([
      { ref: USDC_ADDR, seed: seed("USDC") }, // zerion:合约
      { ref: USDC_SOL_ADDR, seed: seed("USDC") }, // coinstats:合约
      { ref: "binance/USDC", seed: seed("USDC") }, // binance:上架代号
      { ref: "okx/USDC", seed: seed("USDC") }, // okx:上架代号
      { ref: "hyperliquid/USDC", seed: seed("USDC") }, // hyperliquid:保证金币
      { ref: SRC_USDC, seed: seed("USDC") }, // manual:用户选了币,ref 本身就是锚
    ]);

    expect(new Set(got.values()).size).toBe(1); // 全落一个 Token
    expect(store.rows.size).toBe(1);
    // 六条来源 ref + 锚那一条(手记那条与锚同串,去重后不重复)
    expect(store.refs.size).toBe(6);
    expect(store.refs.get(SRC_USDC)).toBe(got.get(USDC_ADDR));
  });

  it("原生币各自归到自己的 Token —— 它们不在映射表里,靠 symbol", async () => {
    const { store, mint } = fullSetup();
    const got = await mint.of([
      { ref: "evm:1/native", seed: seed("ETH") }, // zerion:ETH
      { ref: "bitcoin/native", seed: seed("BTC") }, // blockbook:BTC
      { ref: "solana/native", seed: seed("SOL") }, // coinstats:SOL
    ]);

    expect(new Set(got.values()).size).toBe(3); // 三个不同的币
    expect(store.refs.get("src/ethereum")).toBe(got.get("evm:1/native"));
    expect(store.refs.get("src/bitcoin")).toBe(got.get("bitcoin/native"));
    expect(store.refs.get("src/solana")).toBe(got.get("solana/native"));
  });

  it("手记选了币:ref 本身就是锚 —— 不查映射表、不掉回 symbol", async () => {
    // 故意把 warm 与覆盖表都指到**别的**币上:如果它掉回 symbol 就会认错。
    const { store, refIndex, mint } = setup({
      overrides: { USDC: "wrong-coin" },
      candidates: { USDC: [{ ref: "src/wrong-coin", marketCapRank: 1 }] },
    });
    const before = refIndex.lookups;

    const id = (await mint.of([{ ref: SRC_USDC, seed: seed("USDC") }])).get(SRC_USDC);
    expect(refIndex.lookups).toBe(before); // 没查映射表
    expect(store.refs.get(SRC_USDC)).toBe(id);
    expect(store.refs.has("src/wrong-coin")).toBe(false); // 没被 symbol 那档带跑
    // 只有一条 ref —— 去重生效(ref 与锚同串;不去重会撞 (namer, localName) 主键)
    expect([...store.refs.keys()]).toEqual([SRC_USDC]);
    expect(store.rows.get(id as string)?.ref).toBe(SRC_USDC); // 一进来就是「已认出」
  });

  it("手记没选币:`manual/<SYMBOL>` 认不出就自己一行", async () => {
    const { store, mint } = fullSetup();
    const id = (await mint.of([{ ref: "manual/FOO", seed: seed("FOO") }])).get("manual/FOO");
    expect(store.rows.get(id as string)?.ref).toBeNull();
    expect([...store.refs.keys()]).toEqual(["manual/FOO"]);
  });

  it("手记没选币但 symbol 认得出 → 照样归到那个 Token", async () => {
    const { store, mint } = fullSetup();
    const got = await mint.of([
      { ref: "manual/BTC", seed: seed("BTC") },
      { ref: "bitcoin/native", seed: seed("BTC") },
    ]);
    expect(got.get("manual/BTC")).toBe(got.get("bitcoin/native"));
    expect(store.rows.size).toBe(1);
  });
});
