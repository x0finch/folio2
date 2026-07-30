import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
import {
  createAccount,
  importToken,
  listManualActivityByUser,
  listTokensForExport,
  recordManualActivity,
} from "../src/queries";
import { tokenRefs, tokens } from "../src/schema";

// 导出/导入 v3 的 db 支持(#204):listTokensForExport(带 ref)、importToken(find-or-create)、
// listManualActivityByUser(扁平跨账户)。对着真 D1 跑(约束/唯一索引会在这里真生效)。

const USER_A = "u-a";
const USER_B = "u-b";
const USDC_CGK = { namer: "coingecko", localName: "issued:usd-coin" };
const USDC_ETH = { namer: "evm:1", localName: "contract:0xa0b8" };
const BTC_CGK = { namer: "coingecko", localName: "issued:bitcoin" };

async function resetUser(userId: string): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  await resetUser(USER_A);
  await resetUser(USER_B);
});

const refKey = (r: { namer: string; localName: string }) => `${r.namer}/${r.localName}`;

describe("listTokensForExport", () => {
  it("导出 Token,ref 嵌在里头;空用户 → []", async () => {
    expect(await listTokensForExport(env, USER_A)).toEqual([]);
    const id = await importToken(
      env,
      USER_A,
      { symbol: "USDC", name: "USD Coin", logo: "u.png", providerLogo: "p.png", marketCapRank: 7 },
      [USDC_CGK, USDC_ETH],
    );
    const out = await listTokensForExport(env, USER_A);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id,
      symbol: "USDC",
      name: "USD Coin",
      logo: "u.png",
      providerLogo: "p.png",
      marketCapRank: 7,
    });
    expect(new Set(out[0]!.refs.map(refKey))).toEqual(
      new Set([refKey(USDC_CGK), refKey(USDC_ETH)]),
    );
  });

  it("按用户隔离", async () => {
    await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    expect(await listTokensForExport(env, USER_B)).toEqual([]);
  });
});

describe("importToken —— find-or-create", () => {
  it("空库 → 新建一行,返回新 id", async () => {
    const id = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [USDC_CGK]);
    expect(id).toBeTruthy();
    const rows = await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbol).toBe("USDC");
  });

  it("ref 已存在 → 复用那行,不新建(空库重映射的对面情形)", async () => {
    const id1 = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [USDC_CGK]);
    const id2 = await importToken(env, USER_A, { symbol: "USDCdup", name: "dup" }, [USDC_CGK]);
    expect(id2).toBe(id1);
    expect(await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A))).toHaveLength(1);
  });

  it("复用时把缺的 ref 补挂到已有 Token", async () => {
    const id1 = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [USDC_CGK]);
    const id2 = await importToken(env, USER_A, { symbol: "USDC", name: "USD Coin" }, [
      USDC_CGK,
      USDC_ETH,
    ]);
    expect(id2).toBe(id1);
    const refs = await getDb(env).select().from(tokenRefs).where(eq(tokenRefs.tokenId, id1));
    expect(new Set(refs.map(refKey))).toEqual(new Set([refKey(USDC_CGK), refKey(USDC_ETH)]));
  });

  it("无 ref 的 Token(理论边界)→ 照样建行", async () => {
    const id = await importToken(env, USER_A, { symbol: "FOO", name: "Foo" }, []);
    expect((await getDb(env).select().from(tokens).where(eq(tokens.id, id)))[0]!.symbol).toBe(
      "FOO",
    );
  });
});

describe("listManualActivityByUser", () => {
  it("跨账户扁平返回、按 occurred→created 升序、createdAt 保留、按用户隔离", async () => {
    const acc = await createAccount(env, USER_A, {
      connectorId: "manual",
      label: "M",
      creds: "{}",
    });
    const tk = await importToken(env, USER_A, { symbol: "BTC", name: "Bitcoin" }, [BTC_CGK]);
    await recordManualActivity(env, USER_A, acc.id, tk, {
      kind: "add",
      amount: 1,
      price: 60000,
      occurredAt: 1000,
      createdAt: 5,
    });
    await recordManualActivity(env, USER_A, acc.id, tk, {
      kind: "add",
      amount: 2,
      price: 61000,
      occurredAt: 2000,
      createdAt: 6,
    });

    const out = await listManualActivityByUser(env, USER_A);
    expect(out.map((a) => a.amount)).toEqual([1, 2]); // 升序
    expect(out[0]).toMatchObject({ accountId: acc.id, tokenId: tk, createdAt: 5 }); // createdAt 保留
    expect(await listManualActivityByUser(env, USER_B)).toEqual([]);
  });
});
