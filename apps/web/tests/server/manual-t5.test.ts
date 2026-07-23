import { env } from "cloudflare:test";
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

// T5(#157,ADR 0018)服务端集成:价值历史 compute-on-read。账本(D1 真实)→ (takenAt, totalUsd) 阶梯序列;
// 补录/删/改过去活动 → 整条重算无 stale;price@T 降级链(账本价②/unitPrice③)。真实 D1(Miniflare),
// beforeEach 重置。用受控 occurredAt(不经 createManualAccount 的 Date.now() 开仓,便于断言绝对时刻)。
const USER = "user-manual-t5";
const T0 = 1_600_000_000_000;
const T1 = T0 + 86_400_000; // +1d

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}
beforeEach(resetUser);

// 空 manual 账户(无 token)→ 后续用 addManualActivities 现建 token,occurredAt 全受控。
async function emptyAccount(label = "M") {
  return db.createAccount(USER, {
    connectorId: "manual",
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });
}

const btcRef = { symbol: "BTC", unitPrice: 100, identifier: "bitcoin" };

describe("loadManualAccountSeries", () => {
  it("账本 → 每个活动时刻一行,盯市值 = 数量 × 账本价@T", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 1, occurredAt: T0, price: 60000 },
      { token: btcRef, kind: "add", amount: 1, occurredAt: T1, price: 65000 },
    ]);
    const series = await loadManualAccountSeries(USER, acc.id);
    expect(series).toEqual([
      { accountId: acc.id, takenAt: T0, totalUsd: 1 * 60000 },
      { accountId: acc.id, takenAt: T1, totalUsd: 2 * 65000 }, // 全仓按 T1 账本价盯市
    ]);
  });

  it("补录一条更早活动 → 序列新增前置点,整条重算", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 2, occurredAt: T1, price: 50000 },
    ]);
    expect((await loadManualAccountSeries(USER, acc.id)).map((r) => r.takenAt)).toEqual([T1]);

    // 用户补录「其实 T0 就买了 1」→ 出现 T0 前置点,T1 数量抬到 3。
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 1, occurredAt: T0, price: 40000 },
    ]);
    expect(await loadManualAccountSeries(USER, acc.id)).toEqual([
      { accountId: acc.id, takenAt: T0, totalUsd: 1 * 40000 },
      { accountId: acc.id, takenAt: T1, totalUsd: 3 * 50000 },
    ]);
  });

  it("删除过去活动 → 该时点消失,无 stale 残留", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 1, occurredAt: T0, price: 40000 },
      { token: btcRef, kind: "add", amount: 2, occurredAt: T1, price: 50000 },
    ]);
    const t1Act = (await db.listManualActivityByAccount(USER, acc.id)).find(
      (a) => a.occurredAt === T1,
    );
    if (!t1Act) throw new Error("T1 activity missing");
    await deleteManualActivity(USER, acc.id, t1Act.id);
    expect(await loadManualAccountSeries(USER, acc.id)).toEqual([
      { accountId: acc.id, takenAt: T0, totalUsd: 1 * 40000 },
    ]);
  });

  it("修改过去活动 amount → 自该时点起下游全部重算", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 1, occurredAt: T0, price: 40000 },
      { token: btcRef, kind: "add", amount: 1, occurredAt: T1, price: 50000 },
    ]);
    const t0Act = (await db.listManualActivityByAccount(USER, acc.id)).find(
      (a) => a.occurredAt === T0,
    );
    if (!t0Act) throw new Error("T0 activity missing");
    // T0 那笔 add 从 1 → 3:T0 点与 T1 点(下游)都变。
    const res = await editManualActivity(USER, t0Act.id, { amount: 3 });
    expect(res.ok).toBe(true);
    expect(await loadManualAccountSeries(USER, acc.id)).toEqual([
      { accountId: acc.id, takenAt: T0, totalUsd: 3 * 40000 },
      { accountId: acc.id, takenAt: T1, totalUsd: 4 * 50000 },
    ]);
  });

  it("price@T 降级③:活动未记 price → 用 token 的 unitPrice 摊平", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      // 无 price 字段 → 降级到 ref.unitPrice=100。
      { token: btcRef, kind: "add", amount: 2, occurredAt: T0 },
    ]);
    expect(await loadManualAccountSeries(USER, acc.id)).toEqual([
      { accountId: acc.id, takenAt: T0, totalUsd: 2 * 100 },
    ]);
  });

  it("price@T 降级②:后一活动未记 price → 沿用其前最近记了 price 的活动价", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: btcRef, kind: "add", amount: 1, occurredAt: T0, price: 55000 },
      { token: btcRef, kind: "add", amount: 1, occurredAt: T1 }, // 无 price → 回落 T0 的 55000
    ]);
    expect(await loadManualAccountSeries(USER, acc.id)).toEqual([
      { accountId: acc.id, takenAt: T0, totalUsd: 1 * 55000 },
      { accountId: acc.id, takenAt: T1, totalUsd: 2 * 55000 },
    ]);
  });

  it("空账户 → 空序列", async () => {
    const acc = await emptyAccount();
    expect(await loadManualAccountSeries(USER, acc.id)).toEqual([]);
  });
});

describe("loadManualHistoryRows", () => {
  it("合并多个活跃 manual 账户的账本行,各带自身 accountId", async () => {
    const a = await emptyAccount("A");
    const b = await emptyAccount("B");
    await addManualActivities(USER, a.id, [
      { token: btcRef, kind: "add", amount: 1, occurredAt: T0, price: 60000 },
    ]);
    await addManualActivities(USER, b.id, [
      {
        token: { symbol: "ETH", unitPrice: 10, identifier: "ethereum" },
        kind: "add",
        amount: 2,
        occurredAt: T1,
        price: 3000,
      },
    ]);
    const rows = await loadManualHistoryRows(USER, await db.listAccountsByUser(USER));
    expect(rows).toEqual(
      expect.arrayContaining([
        { accountId: a.id, takenAt: T0, totalUsd: 60000 },
        { accountId: b.id, takenAt: T1, totalUsd: 6000 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("含归档 manual 账户:历史保留其过去贡献(与 synced 快照一致,末点由 live 覆写另行剔出)", async () => {
    const a = await emptyAccount("A");
    const archived = await emptyAccount("Z");
    await addManualActivities(USER, a.id, [
      { token: btcRef, kind: "add", amount: 1, occurredAt: T0, price: 60000 },
    ]);
    await addManualActivities(USER, archived.id, [
      { token: btcRef, kind: "add", amount: 5, occurredAt: T1, price: 60000 },
    ]);
    await db.setArchived(USER, archived.id, true);
    const rows = await loadManualHistoryRows(USER, await db.listAccountsByUser(USER));
    expect(rows).toEqual(
      expect.arrayContaining([
        { accountId: a.id, takenAt: T0, totalUsd: 60000 },
        { accountId: archived.id, takenAt: T1, totalUsd: 5 * 60000 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("loadManualAccountLiveTotal", () => {
  it("当下实时盯市总额(测试环境价缓存冷 → 回退 amount × unitPrice)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      // 账本价 55000,但 live 走现价盯市;测试环境缓存冷 → 回退 unitPrice=100(btcRef),amount=2 → 200。
      { token: btcRef, kind: "add", amount: 2, occurredAt: T0, price: 55000 },
    ]);
    expect(await loadManualAccountLiveTotal(USER, acc.id)).toBe(200);
  });

  it("账户不存在 / 非本人 → null", async () => {
    expect(await loadManualAccountLiveTotal(USER, "no-such-account")).toBeNull();
  });
});
