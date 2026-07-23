import { env } from "cloudflare:test";
import { createTokenPriceHistoryStore } from "@folio/db";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/server/db";
import {
  addManualActivities,
  deleteManualActivity,
  editManualActivity,
  loadManualAccountLiveTotal,
  loadManualAccountSeries,
  loadManualHistoryRows,
} from "../../src/lib/server/manual";

// Phase B(#171,ADR 0019)服务端集成:manual 价值历史在**规则日网格**上 compute-on-read。真实 D1(Miniflare)。
// 网络无关:结构类用例用**无 identifier** 的 token(不触发 oracle priceSeries 回源,走账本价②/unitPrice③);
// ① oracle 历史价用例**预种 token_price_history** + 传过去的 now(priceSeries 的 real-today 判定 → 不取今日桶,
// 请求的过去桶全命中缓存 → 零网络)。beforeEach 重置(pool 不隔离每测存储)。
const USER = "user-manual-grid";
const DAY = 86_400_000;
const B0 = 18518; // 2020-08 附近的某 UTC 日索引
const D0 = B0 * DAY; // 日对齐的开仓时刻 → 日桶数学干净
const dayEnd = (b: number) => (b + 1) * DAY - 1;

// 无 identifier(未选币)→ 价走账本②/unitPrice③,buildHistoricalPriceAt 跳过、不回源。
const localBtc = { symbol: "BTC", unitPrice: 100 };
// 有 identifier(选了币)→ ① 走注入的 oracle 历史价。
const btcRef = { symbol: "BTC", unitPrice: 100, identifier: "bitcoin" };

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM token_price_history").run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}
beforeEach(resetUser);

async function emptyAccount(label = "M") {
  return db.createAccount(USER, {
    connectorId: "manual",
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });
}

describe("loadManualAccountSeries (grid)", () => {
  it("日网格逐日一行;无 identifier → 账本价②盯市(网络无关)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    // now = D0+1d → 网格桶 B0, B0+1。
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series).toEqual([
      { accountId: acc.id, takenAt: dayEnd(B0), totalUsd: 1 * 60000 }, // 桶 B0 日末
      { accountId: acc.id, takenAt: D0 + DAY, totalUsd: 1 * 60000 }, // 桶 B0+1,τ=now
    ]);
  });

  it("① 预种历史价 → 网格用 oracle 历史价(非账本 price),按日桶取", async () => {
    // 预种过去两日的 bitcoin 历史价。priceSeries(ref, D0, now) 的桶全在过去 → 命中缓存、零回源。
    await createTokenPriceHistoryStore(env).putDailyPrices([
      { source: "coingecko", cgkId: "bitcoin", dayBucket: B0, unitPrice: 50000 },
      { source: "coingecko", cgkId: "bitcoin", dayBucket: B0 + 1, unitPrice: 52000 },
    ]);
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      // 账本 price=99999,但选了币(identifier)→ 历史应走 oracle 50000/52000,不用账本价。
      { token: btcRef, kind: "add", amount: 2, occurredAt: D0, price: 99999 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series).toEqual([
      { accountId: acc.id, takenAt: dayEnd(B0), totalUsd: 2 * 50000 }, // ① 桶 B0 → 50000
      { accountId: acc.id, takenAt: D0 + DAY, totalUsd: 2 * 52000 }, // ① 桶 B0+1 → 52000
    ]);
  });

  it("窗口外存量:首活动远早于 now,后续每日点仍携带折出的存量(修 T5 缺口)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0, price: 60000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + 3 * DAY); // 桶 B0..B0+3
    expect(series).toHaveLength(4);
    expect(series.every((r) => r.totalUsd === 2 * 60000)).toBe(true);
  });

  it("补录更早活动 → 网格起点前移 + 整条重算", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0 + DAY, price: 50000 },
    ]);
    // 首活动在 D0+DAY(桶 B0+1),now=D0+DAY → 单点。
    expect((await loadManualAccountSeries(USER, acc.id, D0 + DAY)).map((r) => r.takenAt)).toEqual([
      D0 + DAY,
    ]);
    // 补录 D0 的 add 1 → 网格起点回到桶 B0。
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 40000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series).toEqual([
      { accountId: acc.id, takenAt: dayEnd(B0), totalUsd: 1 * 40000 }, // 新前置日:仅 D0 的 1
      { accountId: acc.id, takenAt: D0 + DAY, totalUsd: 3 * 50000 }, // 桶 B0+1:1+2=3,② 最近价 50000
    ]);
  });

  it("删除过去活动 → 整体重算不留 stale", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 40000 },
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0 + DAY, price: 50000 },
    ]);
    const acts = await db.listManualActivityByAccount(USER, acc.id);
    const later = acts.find((a) => a.occurredAt === D0 + DAY);
    if (!later) throw new Error("later activity missing");
    await deleteManualActivity(USER, acc.id, later.id);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series).toEqual([
      { accountId: acc.id, takenAt: dayEnd(B0), totalUsd: 1 * 40000 },
      { accountId: acc.id, takenAt: D0 + DAY, totalUsd: 1 * 40000 }, // 存量 1 携带,不留旧的 3×50000
    ]);
  });

  it("修改过去活动 amount → 下游重算", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 40000 },
    ]);
    const act = (await db.listManualActivityByAccount(USER, acc.id))[0];
    const res = await editManualActivity(USER, act.id, { amount: 3 });
    expect(res.ok).toBe(true);
    expect(await loadManualAccountSeries(USER, acc.id, D0)).toEqual([
      { accountId: acc.id, takenAt: D0, totalUsd: 3 * 40000 },
    ]);
  });

  it("空账户 → 空序列", async () => {
    const acc = await emptyAccount();
    expect(await loadManualAccountSeries(USER, acc.id, D0)).toEqual([]);
  });
});

describe("loadManualHistoryRows (grid)", () => {
  it("合并多个活跃 manual 账户的网格行,各带自身 accountId", async () => {
    const a = await emptyAccount("A");
    const b = await emptyAccount("B");
    await addManualActivities(USER, a.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    await addManualActivities(USER, b.id, [
      {
        token: { symbol: "ETH", unitPrice: 10 },
        kind: "add",
        amount: 2,
        occurredAt: D0,
        price: 3000,
      },
    ]);
    // now = D0 → 每账户单点。
    const rows = await loadManualHistoryRows(USER, await db.listAccountsByUser(USER), D0);
    expect(rows).toEqual(
      expect.arrayContaining([
        { accountId: a.id, takenAt: D0, totalUsd: 60000 },
        { accountId: b.id, takenAt: D0, totalUsd: 6000 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("含归档 manual 账户:历史保留其过去贡献", async () => {
    const a = await emptyAccount("A");
    const archived = await emptyAccount("Z");
    await addManualActivities(USER, a.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    await addManualActivities(USER, archived.id, [
      { token: localBtc, kind: "add", amount: 5, occurredAt: D0, price: 60000 },
    ]);
    await db.setArchived(USER, archived.id, true);
    const rows = await loadManualHistoryRows(USER, await db.listAccountsByUser(USER), D0);
    expect(rows).toEqual(
      expect.arrayContaining([
        { accountId: a.id, takenAt: D0, totalUsd: 60000 },
        { accountId: archived.id, takenAt: D0, totalUsd: 5 * 60000 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("loadManualAccountLiveTotal", () => {
  it("当下实时盯市总额(测试环境价缓存冷 → 回退 amount × unitPrice)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 2, occurredAt: D0, price: 55000 },
    ]);
    // live 走 enrich 现价盯市;测试环境缓存冷 → 回退 unitPrice=100,amount=2 → 200。
    expect(await loadManualAccountLiveTotal(USER, acc.id)).toBe(200);
  });

  it("账户不存在 / 非本人 → null", async () => {
    expect(await loadManualAccountLiveTotal(USER, "no-such-account")).toBeNull();
  });
});
