import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/server/db";
import {
  addManualActivities,
  createManualAccount,
  editManualActivity,
  loadManualAccountDetail,
} from "../../src/lib/server/manual";

// T4(#156)服务端支撑:抽屉读路径 loadManualAccountDetail(token 定义 + 折叠 amount + 全部活动)+ fee 落库 round-trip。
// 真实 D1(Miniflare);不隔离每测存储 → beforeEach 重置。开仓 set = Date.now(),后续活动用远未来 LATER 排其后。
const USER = "user-manual-t4";
const LATER = 4_000_000_000_000;

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

async function seedAccount() {
  return createManualAccount(
    USER,
    "M",
    JSON.stringify([{ symbol: "BTC", unitPrice: "60000", identifier: "bitcoin", amount: "1" }]),
  );
}

describe("loadManualAccountDetail", () => {
  it("返回 token(带 DB id + 折叠 amount)+ 全部活动(带 tokenId)", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
      },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);

    expect(detail.tokens).toHaveLength(1);
    const [btc] = detail.tokens;
    expect(btc.symbol).toBe("BTC");
    expect(btc.identifier).toBe("bitcoin");
    expect(btc.amount).toBe(1.5); // 开仓 set 1 + add 0.5
    expect(typeof btc.id).toBe("string");

    // 活动:开仓 set + add,均挂在该 token 上。
    expect(detail.activities.map((a) => a.kind).sort()).toEqual(["add", "set"]);
    expect(detail.activities.every((a) => a.tokenId === btc.id)).toBe(true);
  });

  it("空账户(无 token)→ 空 detail", async () => {
    const account = await db.createAccount(USER, {
      connectorId: "manual",
      label: "empty",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    const detail = await loadManualAccountDetail(USER, account.id);
    expect(detail).toEqual({ tokens: [], activities: [] });
  });
});

describe("fee 落库 round-trip", () => {
  it("批量加活动带 fee → 存库可读回", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
        price: 60000,
        fee: 12.5,
      },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);
    const added = detail.activities.find((a) => a.kind === "add");
    expect(added?.fee).toBe(12.5);
    expect(added?.price).toBe(60000);
  });

  it("编辑活动可改 fee(含清空为 null)", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, identifier: "bitcoin" },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
        fee: 5,
      },
    ]);
    const added = (await loadManualAccountDetail(USER, account.id)).activities.find(
      (a) => a.kind === "add",
    );
    if (!added) throw new Error("add missing");

    // 改 fee 5 → 20
    let res = await editManualActivity(USER, added.id, { fee: 20 });
    expect(res.ok).toBe(true);
    expect(
      (await loadManualAccountDetail(USER, account.id)).activities.find((a) => a.id === added.id)
        ?.fee,
    ).toBe(20);

    // 清空 fee → null
    res = await editManualActivity(USER, added.id, { fee: null });
    expect(res.ok).toBe(true);
    expect(
      (await loadManualAccountDetail(USER, account.id)).activities.find((a) => a.id === added.id)
        ?.fee,
    ).toBeNull();
  });
});
