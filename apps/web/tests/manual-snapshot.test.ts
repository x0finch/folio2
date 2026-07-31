import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Tokens } from "@folio/oracle";
import type { TokenRecord } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { deriveLiveAccountTotals } from "../src/lib/live-value";
import type { CredsToken } from "../src/lib/manual-activity";
import { buildManualSnapshot, manualUnitPrices } from "../src/lib/manual-snapshot";

// 缝③ 纯逻辑:manual 的 creds.tokens(+ 逐 token 现价)→ 合成 SnapshotWithBalances(ADR 0018 做法 1)。
// 现价烘焙进 usdValue/totalUsd(取不到回退 unitPrice);selfPrice=null 走盯市。身份走 tokenId,
// 显示名(symbol)与 ref 都住 Token 那一行,合成快照不再各带一份(#243)。
const TS = 1_700_000_000_000;

const tok = (over: Partial<CredsToken>): CredsToken => ({
  id: "tk-BTC",
  symbol: "BTC",
  amount: 2,
  fallbackPrice: 100,
  ref: null,
  ...over,
});

describe("buildManualSnapshot", () => {
  it("每个 token 造一条 spot 余额,amount/tokenId 透传(symbol 住 Token,不再合成)", () => {
    const snap = buildManualSnapshot("acc1", [tok({ id: "tk-BTC", amount: 2 })], [undefined], TS);
    expect(snap.balances).toHaveLength(1);
    expect(snap.balances[0]).toMatchObject({ amount: 2, kind: "spot", tokenId: "tk-BTC" });
  });

  it("有现价 → usdValue = amount × 现价(不用 unitPrice)", () => {
    const snap = buildManualSnapshot("acc1", [tok({ amount: 2, fallbackPrice: 100 })], [130], TS);
    expect(snap.balances[0].usdValue).toBe(260); // 2 × 130,忽略 unitPrice 100
  });

  it("无现价 → 回退 amount × fallbackPrice", () => {
    const snap = buildManualSnapshot(
      "acc1",
      [tok({ amount: 3, fallbackPrice: 50 })],
      [undefined],
      TS,
    );
    expect(snap.balances[0].usdValue).toBe(150); // 3 × 50
  });

  // **tokenId 必须带上**(#203 的收尾):展示富化 / 预热 / 刷价三个门全按它收口,
  // 空着就等于这个币不存在 —— 没有上游名字、没有 logo、也没人去给它取价。
  it("tokenId = tokens.id,不是 null", () => {
    const snap = buildManualSnapshot("acc1", [tok({ id: "tk-abc" })], [undefined], TS);
    expect(snap.balances[0].tokenId).toBe("tk-abc");
  });

  it("selfPrice 恒 null、metaJson 恒 null(盯市语义)", () => {
    const snap = buildManualSnapshot("acc1", [tok({})], [130], TS);
    expect(snap.balances[0].selfPrice).toBeNull();
    expect(snap.balances[0].metaJson).toBeNull();
  });

  it("totalUsd = 各余额 usdValue 之和", () => {
    const snap = buildManualSnapshot(
      "acc1",
      [tok({ amount: 2 }), tok({ symbol: "ETH", amount: 5, fallbackPrice: 10 })],
      [130, undefined],
      TS,
    );
    // 2×130 + 5×10 = 260 + 50 = 310
    expect(snap.snapshot.totalUsd).toBe(310);
  });

  it("空 tokens → 空 balances、totalUsd 0", () => {
    const snap = buildManualSnapshot("acc1", [], [], TS);
    expect(snap.balances).toHaveLength(0);
    expect(snap.snapshot.totalUsd).toBe(0);
  });

  it("snapshot 带上 accountId 与 takenAt", () => {
    const snap = buildManualSnapshot("acc-x", [tok({})], [undefined], TS);
    expect(snap.snapshot.accountId).toBe("acc-x");
    expect(snap.snapshot.takenAt).toBe(TS);
  });
});

// 缝③ 纯逻辑:每条持仓的展示单价装配(ADR 0025 / #270)。法币走 FX 汇率(现算不冻价),
// 非法币走 enrich 现价;两支缺值都回退 undefined(→ buildManualSnapshot 用自填价)。身份**以 ref 为准**。
describe("manualUnitPrices", () => {
  // 假 enrich 结果:按 tokenId 供价,缺 → 无 price 字段。
  const enrich = (priceById: Record<string, number>): ReadonlyMap<string, TokenRecord> =>
    new Map(
      Object.entries(priceById).map(([id, unitPrice]) => [
        id,
        { id, price: { unitPrice, asOf: 0, stale: false } } as unknown as TokenRecord,
      ]),
    );
  // 假 fxResolve:USD 恒 1(与真 FxRates.resolve 同口径);其余按注入表,缺 → undefined。
  const fakeFx = (rates: Record<string, number> = {}) => {
    const asked: string[] = [];
    const resolve = async (code: string): Promise<number | undefined> => {
      asked.push(code);
      const c = code.trim().toUpperCase();
      return c === "USD" ? 1 : rates[c];
    };
    return { resolve, asked };
  };

  const fiat = (over: Partial<CredsToken>): CredsToken =>
    tok({ id: "tk-USD", symbol: "USD", ref: "fiat/issued:USD", ...over });

  it("法币 USD → 汇率 1(不查 enrich)", async () => {
    const { resolve } = fakeFx();
    const prices = await manualUnitPrices([fiat({})], enrich({}), resolve);
    expect(prices).toEqual([1]);
  });

  it("非美元法币 → 用注入汇率(不冻价,随汇率)", async () => {
    const { resolve } = fakeFx({ EUR: 1.1 });
    const prices = await manualUnitPrices(
      [fiat({ id: "tk-EUR", symbol: "EUR", ref: "fiat/issued:EUR" })],
      enrich({}),
      resolve,
    );
    expect(prices).toEqual([1.1]);
  });

  it("非法币 → enrich 现价(不碰 fx)", async () => {
    const { resolve, asked } = fakeFx();
    const prices = await manualUnitPrices(
      [tok({ id: "tk-BTC", symbol: "BTC", ref: "coingecko/issued:bitcoin" })],
      enrich({ "tk-BTC": 65000 }),
      resolve,
    );
    expect(prices).toEqual([65000]);
    expect(asked).toEqual([]); // 非法币不问 fx
  });

  it("法币汇率缺(缓存冷)→ undefined(回退自填价)", async () => {
    const { resolve } = fakeFx(); // EUR 不在表里
    const prices = await manualUnitPrices(
      [fiat({ id: "tk-EUR", symbol: "EUR", ref: "fiat/issued:EUR" })],
      enrich({}),
      resolve,
    );
    expect(prices).toEqual([undefined]);
  });

  it("非法币无现价 → undefined(回退自填价)", async () => {
    const { resolve } = fakeFx();
    const prices = await manualUnitPrices(
      [tok({ id: "tk-X", ref: "coingecko/issued:x" })],
      enrich({}),
      resolve,
    );
    expect(prices).toEqual([undefined]);
  });

  it("ref 为空(没选币的自定义币)→ 当非法币走 enrich,不判成法币", async () => {
    const { resolve, asked } = fakeFx({ USD: 1 });
    const prices = await manualUnitPrices([tok({ id: "tk-c", ref: null })], enrich({}), resolve);
    expect(prices).toEqual([undefined]);
    expect(asked).toEqual([]);
  });

  it("裸 symbol=USD 但 ref 非法币 → 不当法币(身份以 ref 为准)", async () => {
    const { resolve, asked } = fakeFx({ USD: 1 });
    const prices = await manualUnitPrices(
      [tok({ id: "tk-usdcoin", symbol: "USD", ref: "coingecko/issued:some-usd-token" })],
      enrich({ "tk-usdcoin": 42 }),
      resolve,
    );
    expect(prices).toEqual([42]); // 走 enrich,不被 fx 短路成 1
    expect(asked).toEqual([]);
  });

  it("多条同 code 法币 → 只 resolve 一次(去重)", async () => {
    const { resolve, asked } = fakeFx({ EUR: 1.1 });
    const eur = (id: string) => fiat({ id, symbol: "EUR", ref: "fiat/issued:EUR" });
    const prices = await manualUnitPrices([eur("a"), eur("b")], enrich({}), resolve);
    expect(prices).toEqual([1.1, 1.1]);
    expect(asked).toEqual(["EUR"]); // 去重:两条持仓一个 code 只问一次
  });

  it("混合:法币 + 非法币按序对齐", async () => {
    const { resolve } = fakeFx({ EUR: 1.1 });
    const prices = await manualUnitPrices(
      [
        fiat({}), // USD → 1
        tok({ id: "tk-BTC", ref: "coingecko/issued:bitcoin" }), // 现价 65000
        fiat({ id: "tk-EUR", symbol: "EUR", ref: "fiat/issued:EUR" }), // 1.1
      ],
      enrich({ "tk-BTC": 65000 }),
      resolve,
    );
    expect(prices).toEqual([1, 65000, 1.1]);
  });
});

// 合成项流经既有装配的关键保证(Q1):selfPrice=null → 现推取**实时源价**盯市,而非烘焙时的旧值/unitPrice;
// 源价缺失时才回退到烘焙进 usdValue 的值。证明主页(deriveLiveAccountTotals)对 manual 走盯市。
describe("合成 manual 项经 deriveLiveAccountTotals 盯市", () => {
  const account = () =>
    ({ id: "m1", label: "m1", connectorId: "manual", archivedAt: null }) as unknown as AccountSafe;
  // 假 tokens:BTC 现价 65000,其余无价。
  // 按 token_id 供价(#201):id 用 `tk-<SYMBOL>`。
  const fakeTokens = (priceById: Record<string, number>) =>
    ({
      async enrich(ids: readonly string[]) {
        return new Map(
          ids.map((id) => [
            id,
            {
              id,
              ref: "coingecko/issued:x",
              symbol: id.replace("tk-", ""),
              name: id,
              price:
                priceById[id] === undefined
                  ? undefined
                  : { unitPrice: priceById[id], asOf: 0, stale: false },
            },
          ]),
        );
      },
    }) as unknown as Tokens;
  const tokensWithBtc = fakeTokens({ "tk-BTC": 65000 });
  const tokensNoPrice = fakeTokens({});

  // 手记账户:0.5 BTC。现价在 injectManualSnapshots 那一步就烘焙进了 usdValue(它仍走旧参考层),
  // 所以这里模拟两种入库形态。合成行**带 token_id**,所以现推这一侧也能按 id 取到源价 ——
  // 两条路给的是同一个数,下面两条用例分别钉住「取到」与「取不到」。
  const byAccount = (bakedPrice?: number) =>
    new Map<string, SnapshotWithBalances>([
      [
        "m1",
        buildManualSnapshot(
          "m1",
          [
            {
              id: "tk-BTC",
              symbol: "BTC",
              amount: 0.5,
              fallbackPrice: 30000,
              ref: "src/issued:bitcoin",
            },
          ],
          [bakedPrice],
          TS,
        ),
      ],
    ]);

  // 净值是实时的:inject 那一步烘焙过一次,现推按 token_id 又能取到同一个价。
  it("烘焙进的现价即最终净值(0.5×65000)", async () => {
    const totals = await deriveLiveAccountTotals(
      [account()],
      byAccount(65000),
      tokensWithBtc,
      "self-first",
    );
    expect(totals.get("m1")).toBe(32500);
  });

  // 取不到源价(上游还没认出这个币)→ 回退到烘焙好的 usdValue,也就是用户自填的单价。
  // 这一条正是自定义币的形状:它永远拿不到源价,所以永远用他填的那个数。
  it("inject 时也没取到价 → 回退 token 自填单价(0.5×30000)", async () => {
    const totals = await deriveLiveAccountTotals(
      [account()],
      byAccount(),
      tokensNoPrice,
      "self-first",
    );
    expect(totals.get("m1")).toBe(15000);
  });
});
