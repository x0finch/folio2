import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Tokens } from "@folio/oracle2";
import { describe, expect, it } from "vitest";
import { deriveLiveAccountTotals } from "../src/lib/live-value";
import type { CredsToken } from "../src/lib/manual-activity";
import { buildManualSnapshot } from "../src/lib/manual-snapshot";

// 缝③ 纯逻辑:manual 的 creds.tokens(+ 逐 token 现价)→ 合成 SnapshotWithBalances(ADR 0018 做法 1)。
// 现价烘焙进 usdValue/totalUsd(取不到回退 unitPrice);selfPrice=null 走盯市;tokenRef 恒有值。
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
  it("每个 token 造一条 spot 余额,symbol/amount 透传", () => {
    const snap = buildManualSnapshot("acc1", [tok({ symbol: "BTC", amount: 2 })], [undefined], TS);
    expect(snap.balances).toHaveLength(1);
    expect(snap.balances[0]).toMatchObject({ symbol: "BTC", amount: 2, kind: "spot" });
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

  // 有 ref → **原样搬**(本文件不认识上游,所以夹具用一个随便的命名者就够);
  // 没有 → 手记自己命名,`custom:` 说明这个名字没有背书。
  it("有 ref → 原样搬;无 → manual/custom:<名字>(恒有值)", () => {
    const withRef = buildManualSnapshot(
      "acc1",
      [tok({ ref: "src/issued:bitcoin" })],
      [undefined],
      TS,
    );
    expect(withRef.balances[0].tokenRef).toBe("src/issued:bitcoin");
    const noRef = buildManualSnapshot("acc1", [tok({ ref: null })], [undefined], TS);
    expect(noRef.balances[0].tokenRef).toBe("manual/custom:BTC");
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
