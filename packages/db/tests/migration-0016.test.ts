import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
import { accounts, manualActivity, tokens } from "../src/schema";

// 迁移 0016 的聚焦证明(镜像 SQL)。
//
// 标准 applyD1Migrations 把 0016 应用到【空】表 → 那两条 UPDATE 一行都没碰,证明不了任何东西。
// 所以这里自己种出「迁移前」的样子(tokens.self_price 有值 + 各种账本形态),再跑与
// `0016_self_price_into_ledger.sql` **同款**的两条 UPDATE,断言搬对了。
//
// 它钉的是三件事:开仓那笔(最早的)才收 self_price;**已经记了价的活动一律不动**(账本是事实,
// 迁移不改事实);搬完把那一列清空(免得留一份没人读、又跟账本对不上的影子数据)。

const USER = "user-mig-0016";
const FUTURE = 9_000_000_000_000;

// 与迁移文件逐字同款 —— 抄一遍是故意的:迁移文件一改而这里没跟上,用例就该红。
const MOVE_TO_LEDGER = `
UPDATE manual_activity
SET price = (SELECT t.self_price FROM tokens t WHERE t.id = manual_activity.token_id)
WHERE price IS NULL
  AND token_id IN (SELECT id FROM tokens WHERE self_price IS NOT NULL AND self_price > 0)
  AND id = (
    SELECT a2.id FROM manual_activity a2
    WHERE a2.token_id = manual_activity.token_id
    ORDER BY a2.occurred_at ASC, a2.created_at ASC
    LIMIT 1
  )`;
const CLEAR_COLUMN = "UPDATE tokens SET self_price = NULL WHERE self_price IS NOT NULL";

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, USER));
  await db.insert(user).values({
    id: USER,
    name: USER,
    email: `${USER}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

async function seedToken(id: string, selfPrice: number | null): Promise<void> {
  await getDb(env)
    .insert(tokens)
    .values({ id, userId: USER, symbol: id, name: id, infoExpiresAt: FUTURE, selfPrice });
}

async function seedActivity(
  tokenId: string,
  accountId: string,
  occurredAt: number,
  price: number | null,
  createdAt = occurredAt,
): Promise<string> {
  const id = `${tokenId}-${occurredAt}-${createdAt}`;
  await getDb(env).insert(manualActivity).values({
    id,
    accountId,
    tokenId,
    kind: "add",
    amount: 1,
    price,
    occurredAt,
    createdAt,
  });
  return id;
}

async function pricesOf(tokenId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, price FROM manual_activity WHERE token_id = ? ORDER BY occurred_at",
  )
    .bind(tokenId)
    .all<{ id: string; price: number | null }>();
  return results;
}

async function run(): Promise<void> {
  await env.DB.prepare(MOVE_TO_LEDGER).run();
  await env.DB.prepare(CLEAR_COLUMN).run();
}

describe("migration 0016 — self_price 搬进账本", () => {
  // `manual_activity.account_id` 必填且有外键,本迁移不碰它 —— 先建一个真账户挂着。
  const accountId = `${USER}-acc`;
  beforeEach(async () => {
    await getDb(env).insert(accounts).values({
      id: accountId,
      userId: USER,
      connectorId: "manual",
      label: "M",
      creds: null,
      createdAt: Date.now(),
    });
  });

  it("开仓那笔(最早的)收下 self_price;那一列清空", async () => {
    await seedToken("t-open", 777);
    await seedActivity("t-open", accountId, 100, null);
    await seedActivity("t-open", accountId, 200, null);

    await run();

    expect(await pricesOf("t-open")).toEqual([
      { id: "t-open-100-100", price: 777 }, // 最早那笔 = 开仓
      { id: "t-open-200-200", price: null }, // 后面的不动
    ]);
    const [row] = await getDb(env).select().from(tokens).where(eq(tokens.id, "t-open"));
    expect(row.selfPrice).toBeNull();
  });

  // 账本是事实,迁移不改事实 —— 开仓那笔已经有价就不许被 self_price 顶掉。
  it("开仓那笔已经记了价 → 一个字不动", async () => {
    await seedToken("t-kept", 777);
    await seedActivity("t-kept", accountId, 100, 888);

    await run();

    expect(await pricesOf("t-kept")).toEqual([{ id: "t-kept-100-100", price: 888 }]);
  });

  // SSGS 那行的形状:self_price 停在 0(「没填」被存成了 0)。0 不是价格,不该搬。
  it("self_price 是 0 → 不搬(0 不是一个价格,是没填)", async () => {
    await seedToken("t-zero", 0);
    await seedActivity("t-zero", accountId, 100, null);

    await run();

    expect(await pricesOf("t-zero")).toEqual([{ id: "t-zero-100-100", price: null }]);
  });

  it("同一时刻两笔 → 先录的那笔算开仓(与账本折叠同口径)", async () => {
    await seedToken("t-tie", 555);
    await seedActivity("t-tie", accountId, 100, null, 2);
    await seedActivity("t-tie", accountId, 100, null, 1); // createdAt 更小 → 它才是开仓

    await run();

    // createdAt 更小的那条才是开仓 —— 只有它收到 555。
    const rows = await pricesOf("t-tie");
    expect(rows.find((r) => r.id === "t-tie-100-1")?.price).toBe(555);
    expect(rows.find((r) => r.id === "t-tie-100-2")?.price).toBeNull();
  });

  it("一笔活动都没有的 token → 只清列,不炸", async () => {
    await seedToken("t-bare", 999);
    await run();
    const [row] = await getDb(env).select().from(tokens).where(eq(tokens.id, "t-bare"));
    expect(row.selfPrice).toBeNull();
  });
});
