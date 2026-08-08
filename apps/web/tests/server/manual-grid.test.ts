import { env } from "cloudflare:test";
import { userTokenPriceStoreLayer } from "@folio/db";
import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { TokenPriceStore } from "@folio/oracle-basic/ports";
import { tokenRef } from "@folio/oracle-ref";
import { beforeEach, describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "../../src/lib/history";
import { db } from "../../src/lib/server/internal/db";
import {
  addManualActivities,
  deleteManualActivity,
  editManualActivity,
  loadManualAccountLiveTotal,
  loadManualAccountSeries,
  loadManualHistoryRows,
} from "../../src/lib/server/internal/manual";
import { NAMER } from "../../src/lib/server/internal/oracle";
import { withStore } from "./db-effect";
import { ticketOf } from "./ticket";

// Phase B(#171,ADR 0019)服务端集成:manual 价值历史在**规则日网格**上 compute-on-read。真实 D1(Miniflare)。
// 网络无关:结构类用例用**无 identifier** 的 token(不触发 oracle priceSeries 回源,走账本价②/unitPrice③);
// ① oracle 历史价用例**预种 token_daily_prices** + 传过去的 now(priceSeries 的 real-today 判定 → 不取今日桶,
// 请求的过去桶全命中缓存 → 零网络)。beforeEach 重置(pool 不隔离每测存储)。
const USER = "user-manual-grid";
const DAY = 86_400_000;
const B0 = 18518; // 2020-08 附近的某 UTC 日索引
const D0 = B0 * DAY; // 日对齐的开仓时刻 → 日桶数学干净

// 无 identifier(未选币)→ 价走账本②/unitPrice③,buildHistoricalPriceAt 跳过、不回源。
const localBtc = { symbol: "BTC", unitPrice: 100 };
// 有 identifier(选了币)→ ① 走注入的 oracle 历史价。
const btcRef = { symbol: "BTC", unitPrice: 100, ticket: ticketOf("bitcoin") };
// 法币现金(ADR 0026):票携带 fiat 身份 → 历史价走「当天汇率」,不走币价。
const eurCash = {
  symbol: "EUR",
  unitPrice: 1.15,
  ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "EUR")),
};
const usdCash = {
  symbol: "USD",
  unitPrice: 1,
  ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "USD")),
};
// 法币历史日汇率按 `fiat/issued:<CODE>` 直存 token_daily_prices(getDailyByRef;无 tokenId 翻译)。
async function seedFiatDaily(
  code: string,
  rows: { dayBucket: number; unitPrice: number }[],
): Promise<void> {
  await withStore(TokenPriceStore, userTokenPriceStoreLayer({ userId: USER, namer: NAMER }), (s) =>
    s.putDailyByRef(tokenRef.issued(FIAT_NAMER, code), rows),
  );
}
// #203:历史价按 **token_id** 取(新参考层的 priceSeries 收内部 id),不再按厂商 ref 拼键。
// 所以要先让持仓落库、拿到 mint 出来的 id,再往那个 id 上种价。
async function seedDaily(
  accountId: string,
  rows: { dayBucket: number; unitPrice: number }[],
): Promise<void> {
  const [h] = await db.listManualHoldingsByAccount(USER, accountId, NAMER);
  await withStore(TokenPriceStore, userTokenPriceStoreLayer({ userId: USER, namer: NAMER }), (s) =>
    s.putDaily(h.id, rows),
  );
}

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM token_daily_prices").run();
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
  it("网格首点锚首活动、末点 now;无 identifier → 账本价②盯市(网络无关)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    // now = D0+1d → 首活动 D0 + 日末 + now。
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 1 * 60000 }); // 锚首活动
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 1 * 60000,
    }); // 末点 now
    expect(series.every((r) => r.totalUsd === 1 * 60000)).toBe(true);
  });

  it("① 预种历史价 → 网格用 oracle 历史价(非账本 price),按日桶取", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      // 账本 price=99999,但选了币(identifier)→ 历史应走 oracle 50000/52000,不用账本价。
      { token: btcRef, kind: "add", amount: 2, occurredAt: D0, price: 99999 },
    ]);
    // 预种过去两日的历史价。priceSeries 的桶全在过去 → 命中缓存、零回源。
    await seedDaily(acc.id, [
      { dayBucket: B0, unitPrice: 50000 },
      { dayBucket: B0 + 1, unitPrice: 52000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    // 首活动 D0(桶 B0 → 50000)、末点 now=D0+DAY(桶 B0+1 → 52000);数量 2。用 oracle 价而非账本 99999。
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 2 * 50000 });
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 2 * 52000,
    });
    expect(series.some((r) => r.totalUsd === 2 * 52000)).toBe(true); // 确用了 B0+1 的历史价
  });

  // 法币现金端到端(ADR 0026 / #276):各点按**当天汇率**折算,不被账本冻的入账汇率拖平。
  it("① 非美元法币:历史各点按当天汇率画,不用账本冻价", async () => {
    const acc = await emptyAccount();
    // 账本 price=1.15(入账那刻冻的汇率);选了法币 → 历史应走当天汇率 1.2 / 1.1,不用 1.15。
    await addManualActivities(USER, acc.id, [
      { token: eurCash, kind: "set", amount: 100, occurredAt: D0, price: 1.15 },
    ]);
    // 过去两日的历史日汇率(桶全在过去 → rateSeries 命中缓存、零回源)。
    await seedFiatDaily("EUR", [
      { dayBucket: B0, unitPrice: 1.2 },
      { dayBucket: B0 + 1, unitPrice: 1.1 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    // 首活动 D0(桶 B0 → 1.2)、末点 D0+DAY(桶 B0+1 → 1.1);数量 100。用当天汇率而非账本 1.15。
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 100 * 1.2 });
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 100 * 1.1,
    });
  });

  // USD 现金:汇率恒 1,全程 ×数量,不出网、不需要种任何汇率。
  it("① 美元现金:全程 ×1,行为不变", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: usdCash, kind: "set", amount: 500, occurredAt: D0, price: 1 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + DAY);
    expect(series.every((r) => r.totalUsd === 500)).toBe(true);
  });

  it("窗口外存量:首活动远早于 now,后续每日点仍携带折出的存量(修 T5 缺口)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0, price: 60000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id, D0 + 3 * DAY);
    expect(series[0].takenAt).toBe(D0); // 锚首活动
    expect(series[series.length - 1].takenAt).toBe(D0 + 3 * DAY); // 铺到 now
    expect(series.length).toBeGreaterThanOrEqual(4);
    expect(series.every((r) => r.totalUsd === 2 * 60000)).toBe(true);
  });

  // T5 老 bug 原样回归:抽屉切到某时间窗(since 在唯一活动之后),旧实现按「交易时刻」采样 → 窗口内无点 →
  // 账户在该窗看着是空的。网格修复:逐日铺满,since 之后的点仍反映其前活动折出的存量。这里按 getAccountHistory
  // 的做法组合 loadManualAccountSeries(真实 D1 网格)+ buildAccountValueHistory(rows, since) 端到端钉住。
  it("since 窗口起点晚于唯一活动 → 窗口内仍显存量(非空),不再被丢(修 T5 老 bug)", async () => {
    const acc = await emptyAccount();
    // 唯一一笔活动在 D0;窗口 since = D0+2d(在活动之后)。now = D0+4d。
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 2, occurredAt: D0, price: 60000 },
    ]);
    const rows = await loadManualAccountSeries(USER, acc.id, D0 + 4 * DAY);
    const windowed = buildAccountValueHistory(
      rows.map((r) => ({ takenAt: r.takenAt, totalUsd: r.totalUsd })),
      D0 + 2 * DAY, // since:晚于唯一活动(D0)
    );
    // 旧实现:rows 只有 D0 一个点 → since 过滤后为空。网格:since 之后每天都有点,值 = 带过来的 2×60000。
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.every((p) => p.total === 2 * 60000)).toBe(true);
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
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 1 * 40000 }); // 起点回到 D0
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 3 * 50000,
    }); // 末点:1+2=3,② 最近价 50000
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
    expect(series[0]).toEqual({ accountId: acc.id, takenAt: D0, totalUsd: 1 * 40000 });
    expect(series[series.length - 1]).toEqual({
      accountId: acc.id,
      takenAt: D0 + DAY,
      totalUsd: 1 * 40000,
    }); // 存量 1 携带,不留旧的 3×50000
    expect(series.every((r) => r.totalUsd === 1 * 40000)).toBe(true);
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

  it("删除开仓 set 后账本超卖 → 末值逐步夹 0 后回升,不归零(用户实景回归)", async () => {
    const acc = await emptyAccount();
    // set10 开仓,再 add1 / reduce2 / add1(runningOk 写时不超卖:10→11→9→10)。
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "set", amount: 10, occurredAt: D0, price: 50000 },
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0 + DAY, price: 60000 },
      { token: localBtc, kind: "reduce", amount: 2, occurredAt: D0 + 2 * DAY, price: 61000 },
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0 + 3 * DAY, price: 62000 },
    ]);
    // 删掉开仓 set10 → 账本回溯超卖:add1 / reduce2 / add1(delete 不重校验超卖)。
    const setAct = (await db.listManualActivityByAccount(USER, acc.id)).find(
      (x) => x.occurredAt === D0,
    );
    if (!setAct) throw new Error("set activity missing");
    await deleteManualActivity(USER, acc.id, setAct.id);

    const series = await loadManualAccountSeries(USER, acc.id, D0 + 3 * DAY);
    // 逐步:add1→1、reduce2→归0、add1→1。末点数量 1(非 (1−2+1)=0),值 = 1 × 账本价② 62000。
    const last = series[series.length - 1];
    expect(last.totalUsd).toBe(1 * 62000);
    expect(last.totalUsd).toBeGreaterThan(0); // 关键回归:删开仓后不再整体归 0
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
  it("当下实时盯市总额(缓存冷 → 回退 amount × 账本最近一笔的价)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 2, occurredAt: D0, price: 55000 },
    ]);
    // live 走 enrich 现价盯市;测试环境缓存冷 → 回退到**账本**里那笔 55000(价只有账本一个来源),
    // 2 × 55000 = 110000。以前这里回退的是草稿上那个 `unitPrice: 100`,那条路已经没有了。
    expect(await loadManualAccountLiveTotal(USER, acc.id)).toBe(110000);
  });

  it("账户不存在 / 非本人 → null", async () => {
    expect(await loadManualAccountLiveTotal(USER, "no-such-account")).toBeNull();
  });

  it("live compute-on-read:物化 creds.tokens 过期(amount 0)也按账本折叠,不卡在 stale", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: D0, price: 60000 },
    ]);
    // 手动把物化投影弄成过期(amount 0),模拟「删更早活动后 creds 携带旧值 / 折叠语义修正前写入」的 stale 态。
    await db.setAccountCredentials(
      USER,
      acc.id,
      JSON.stringify({ tokens: JSON.stringify([{ symbol: "BTC", unitPrice: 100, amount: 0 }]) }),
    );
    // live 按账本现算(1 × 账本那笔 60000,缓存冷回退)= 60000,而非 stale creds 的 0。
    expect(await loadManualAccountLiveTotal(USER, acc.id)).toBe(60000);
  });
});
