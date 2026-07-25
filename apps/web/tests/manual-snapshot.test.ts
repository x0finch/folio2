import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import type { Tokens } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import { deriveLiveAccountTotals } from "../src/lib/live-value";
import type { CredsToken } from "../src/lib/manual-activity";
import { buildManualSnapshot } from "../src/lib/manual-snapshot";

// 缝③ 纯逻辑:manual 的 creds.tokens(+ 逐 token 现价)→ 合成 SnapshotWithBalances(ADR 0018 做法 1)。
// 现价烘焙进 usdValue/totalUsd(取不到回退 unitPrice);selfPrice=null 走盯市;tokenRef 由 identifier 生。
const TS = 1_700_000_000_000;

const tok = (over: Partial<CredsToken>): CredsToken => ({
  symbol: "BTC",
  unitPrice: 100,
  amount: 2,
  ...over,
});

describe("buildManualSnapshot", () => {
  it("每个 token 造一条 spot 余额,symbol/amount 透传", () => {
    const snap = buildManualSnapshot("acc1", [tok({ symbol: "BTC", amount: 2 })], [undefined], TS);
    expect(snap.balances).toHaveLength(1);
    expect(snap.balances[0]).toMatchObject({ symbol: "BTC", amount: 2, kind: "spot" });
  });

  it("有现价 → usdValue = amount × 现价(不用 unitPrice)", () => {
    const snap = buildManualSnapshot("acc1", [tok({ amount: 2, unitPrice: 100 })], [130], TS);
    expect(snap.balances[0].usdValue).toBe(260); // 2 × 130,忽略 unitPrice 100
  });

  it("无现价 → 回退 amount × unitPrice", () => {
    const snap = buildManualSnapshot("acc1", [tok({ amount: 3, unitPrice: 50 })], [undefined], TS);
    expect(snap.balances[0].usdValue).toBe(150); // 3 × 50
  });

  it("selfPrice 恒 null、metaJson 恒 null(盯市语义)", () => {
    const snap = buildManualSnapshot("acc1", [tok({})], [130], TS);
    expect(snap.balances[0].selfPrice).toBeNull();
    expect(snap.balances[0].metaJson).toBeNull();
  });

  it("有 identifier → tokenRef = coingecko/<id>;无 → null", () => {
    const withId = buildManualSnapshot("acc1", [tok({ identifier: "Bitcoin" })], [undefined], TS);
    expect(withId.balances[0].tokenRef).toBe("coingecko/bitcoin");
    const noId = buildManualSnapshot("acc1", [tok({ identifier: undefined })], [undefined], TS);
    expect(noId.balances[0].tokenRef).toBeNull();
  });

  it("totalUsd = 各余额 usdValue 之和", () => {
    const snap = buildManualSnapshot(
      "acc1",
      [tok({ amount: 2 }), tok({ symbol: "ETH", amount: 5, unitPrice: 10 })],
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
  const tokensWithBtc = {
    async enrich(assets: ({ symbol: string } | null)[]) {
      return assets.map((a) =>
        a?.symbol === "BTC"
          ? { ref: null, priceStale: false, unitPrice: 65000 }
          : { ref: null, priceStale: false, unitPrice: undefined },
      );
    },
  } as unknown as Tokens;
  const tokensNoPrice = {
    async enrich(assets: ({ symbol: string } | null)[]) {
      return assets.map(() => ({ ref: null, priceStale: false, unitPrice: undefined }));
    },
  } as unknown as Tokens;

  // manual 账户:0.5 BTC,建合成时无现价 → 烘焙 usdValue = 0.5×30000 = 15000。
  const byAccount = () =>
    new Map<string, SnapshotWithBalances>([
      [
        "m1",
        buildManualSnapshot(
          "m1",
          [{ symbol: "BTC", unitPrice: 30000, amount: 0.5, identifier: "bitcoin" }],
          [undefined],
          TS,
        ),
      ],
    ]);

  it("有实时源价 → 取源价(0.5×65000),不用烘焙的旧值", async () => {
    const totals = await deriveLiveAccountTotals(
      [account()],
      byAccount(),
      tokensWithBtc,
      "self-first",
    );
    expect(totals.get("m1")).toBe(32500);
  });

  it("源价缺失 → 回退烘焙进 usdValue 的值(0.5×30000)", async () => {
    const totals = await deriveLiveAccountTotals(
      [account()],
      byAccount(),
      tokensNoPrice,
      "self-first",
    );
    expect(totals.get("m1")).toBe(15000);
  });
});
