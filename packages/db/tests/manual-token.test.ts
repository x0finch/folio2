import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
// 包内白盒:query 实现从内部模块直接引(公开面只出 createDb 门面,见 encapsulation.test)。
import {
  createAccount,
  deleteAccount,
  detachManualHolding,
  listManualActivityByToken,
  listManualHoldingsByAccount,
  recordManualActivity,
  setManualHoldingDef,
} from "../src/queries";
import { manualActivity, tokens as tokensTable } from "../src/schema";
import { createUserTokenStore } from "../src/user-token-store";

// #203 起手记的币**就是 `tokens` 里的一行** —— 没有 manual_token 那张表了。
// 于是「这个账户持有哪些币」由它账本里出现过的 token 决定,而不是另存一份账户↔币的关系。
// 本文件因此测的是这条推导 + 两道归属闸,而不是一张关系表的 CRUD。

const USER_A = "user-a";
const USER_B = "user-b";
const NAMER = "coingecko";

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

async function manualAccount(userId: string) {
  return createAccount(env, userId, { connectorId: "manual", label: "M", creds: "{}" });
}

// 建一个该用户的代币行(生产路径是 mint;这里直接用 store,本文件不测认币)。
// `coinId` 给了就顺带挂上那条 ref —— 持仓的 `ref` 就是从 `token_refs` 里当前命名者那行读出来的。
async function mintToken(userId: string, symbol: string, coinId?: string): Promise<string> {
  const store = createUserTokenStore(env, { userId, namer: NAMER });
  return store.create({ symbol }, coinId ? [`${NAMER}/issued:${coinId}`] : []);
}

// 同上,但那条 ref 的 localName 由调用方整段给(用来喂非 `issued` 的形状)。
async function mintTokenWithRef(
  userId: string,
  symbol: string,
  localName: string,
): Promise<string> {
  const store = createUserTokenStore(env, { userId, namer: NAMER });
  return store.create({ symbol }, [`${NAMER}/${localName}`]);
}

describe("手记持仓(= tokens 行 + 账本)", () => {
  it("持有哪些币由账本推出来;ref 读当前命名者那一行", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    const eth = await mintToken(USER_A, "ETH");
    await setManualHoldingDef(env, USER_A, btc, { symbol: "BTC", unitPrice: 64000 });
    await setManualHoldingDef(env, USER_A, eth, { symbol: "ETH", unitPrice: 3200 });
    // BTC 先开仓 → 序在前(按「什么时候开始持有它」排)。
    await recordManualActivity(env, USER_A, acc.id, btc, {
      kind: "set",
      amount: 1,
      occurredAt: 100,
    });
    await recordManualActivity(env, USER_A, acc.id, eth, {
      kind: "set",
      amount: 2,
      occurredAt: 200,
    });

    const rows = await listManualHoldingsByAccount(env, USER_A, acc.id, NAMER);
    // **整条 ref,不是右半边。** 只回 `bitcoin` 的话,每个调用方都得把 `<命名者>/issued:` 补回去,
    // 而补它就得知道当前上游是谁 —— 那件事就此漏出 db(#227 评审)。
    expect(rows.map((r) => [r.symbol, r.unitPrice, r.ref])).toEqual([
      ["BTC", 64000, `${NAMER}/issued:bitcoin`],
      ["ETH", 3200, null], // 这位命名者还没认出它
    ]);
  });

  // 右半边是什么形状,`ref` 都照原样给整条 —— 本层不替调用方判「这算不算用户选的币」。
  // 挡「拿手敲的名字去认币」是 mint 的活(`hasTrustedSymbol`,ADR 0020 第四轮),不是这个投影的。
  it("ref 不挑形状:合约地址与手敲的名字也照样给整条", async () => {
    const acc = await manualAccount(USER_A);
    const onchain = await mintTokenWithRef(USER_A, "SCAM", "contract:0xdead");
    const typed = await mintTokenWithRef(USER_A, "MYCOIN", "custom:MYCOIN");
    for (const [i, id] of [onchain, typed].entries()) {
      await recordManualActivity(env, USER_A, acc.id, id, {
        kind: "set",
        amount: 1,
        occurredAt: 100 + i,
      });
    }

    const rows = await listManualHoldingsByAccount(env, USER_A, acc.id, NAMER);
    expect(rows.map((r) => [r.symbol, r.ref])).toEqual([
      ["SCAM", `${NAMER}/contract:0xdead`],
      ["MYCOIN", `${NAMER}/custom:MYCOIN`],
    ]);
  });

  it("没有活动的币不算这个账户的持仓", async () => {
    const acc = await manualAccount(USER_A);
    await mintToken(USER_A, "BTC", "bitcoin"); // 代币行在,但这个账户没碰过它
    expect(await listManualHoldingsByAccount(env, USER_A, acc.id, NAMER)).toEqual([]);
  });

  // 同一个币被两个手记账户持有 —— 旧模型下这是两条 manual_token 行,现在是一行 tokens + 两份账本。
  it("两个账户持同一个币:各自的数量互不干扰,共用一条代币行", async () => {
    const a1 = await manualAccount(USER_A);
    const a2 = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    await recordManualActivity(env, USER_A, a1.id, btc, { kind: "set", amount: 1, occurredAt: 1 });
    await recordManualActivity(env, USER_A, a2.id, btc, { kind: "set", amount: 5, occurredAt: 1 });

    // 各自只看见自己那一份账本 —— 按 token 取活动**必须带 accountId**,否则数量会串。
    expect((await listManualActivityByToken(env, USER_A, a1.id, btc)).map((r) => r.amount)).toEqual(
      [1],
    );
    expect((await listManualActivityByToken(env, USER_A, a2.id, btc)).map((r) => r.amount)).toEqual(
      [5],
    );
    // 两边都认得这个币,而且是同一行。
    expect((await listManualHoldingsByAccount(env, USER_A, a1.id, NAMER))[0].id).toBe(btc);
    expect((await listManualHoldingsByAccount(env, USER_A, a2.id, NAMER))[0].id).toBe(btc);
  });

  it("按 token 取活动:按 occurred_at 升序,且带上 (账户, token) 两个键", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await recordManualActivity(env, USER_A, acc.id, btc, {
      kind: "add",
      amount: 5,
      occurredAt: 200,
    });
    await recordManualActivity(env, USER_A, acc.id, btc, {
      kind: "set",
      amount: 10,
      occurredAt: 100,
    });
    const rows = await listManualActivityByToken(env, USER_A, acc.id, btc);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ["set", 10],
      ["add", 5],
    ]);
    expect(rows.every((r) => r.tokenId === btc && r.accountId === acc.id)).toBe(true);
  });

  it("改声明只动 symbol 与单价 —— 名字 / 图 / 上游 ref 归参考层,手记不覆盖", async () => {
    const acc = await manualAccount(USER_A);
    const foo = await mintToken(USER_A, "FOO", "foo-token");
    await recordManualActivity(env, USER_A, acc.id, foo, { kind: "set", amount: 1, occurredAt: 1 });
    await setManualHoldingDef(env, USER_A, foo, { symbol: "FOO", unitPrice: 2.5 });

    const [row] = await listManualHoldingsByAccount(env, USER_A, acc.id, NAMER);
    expect([row.unitPrice, row.ref]).toEqual([2.5, `${NAMER}/issued:foo-token`]); // ref 没被动
  });

  it("没声明过单价 → 读出 0(展示层退回市场价)", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await recordManualActivity(env, USER_A, acc.id, btc, { kind: "set", amount: 1, occurredAt: 1 });
    expect((await listManualHoldingsByAccount(env, USER_A, acc.id, NAMER))[0].unitPrice).toBe(0);
  });

  // 清空一个持仓 = 删该账户对它的活动。**代币行留着** —— 它带着上游 ref / 名字 / 图,
  // 而且别的账户可能还在用。
  it("清空持仓只删这个账户的活动,代币行与别的账户不受影响", async () => {
    const a1 = await manualAccount(USER_A);
    const a2 = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    await recordManualActivity(env, USER_A, a1.id, btc, { kind: "set", amount: 1, occurredAt: 1 });
    await recordManualActivity(env, USER_A, a2.id, btc, { kind: "set", amount: 5, occurredAt: 1 });

    await detachManualHolding(env, USER_A, a1.id, btc);

    expect(await listManualHoldingsByAccount(env, USER_A, a1.id, NAMER)).toEqual([]);
    expect(await listManualHoldingsByAccount(env, USER_A, a2.id, NAMER)).toHaveLength(1);
    const rows = await getDb(env).select().from(tokensTable).where(eq(tokensTable.id, btc));
    expect(rows).toHaveLength(1); // 代币行还在
  });
});

describe("归属:两道闸各自都得挡住", () => {
  it("拿别人的 token 记活动 → 抛,不会挂到对方的币上", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    const accB = await manualAccount(USER_B);
    // B 用自己的账户 + A 的 tokenId:账户那道闸过得去,token 那道必须挡住。
    await expect(
      recordManualActivity(env, USER_B, accB.id, btc, { kind: "set", amount: 1, occurredAt: 1 }),
    ).rejects.toThrow();
    expect(await listManualActivityByToken(env, USER_A, acc.id, btc)).toEqual([]);
  });

  it("拿别人的账户记活动 → 抛", async () => {
    const acc = await manualAccount(USER_A);
    const tokenB = await mintToken(USER_B, "BTC");
    await expect(
      recordManualActivity(env, USER_B, acc.id, tokenB, { kind: "set", amount: 1, occurredAt: 1 }),
    ).rejects.toThrow();
  });

  it("别人读不到、改不了、清不掉", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await recordManualActivity(env, USER_A, acc.id, btc, { kind: "set", amount: 1, occurredAt: 1 });

    await expect(listManualHoldingsByAccount(env, USER_B, acc.id, NAMER)).rejects.toThrow();
    await expect(
      setManualHoldingDef(env, USER_B, btc, { symbol: "X", unitPrice: 9 }),
    ).rejects.toThrow();
    await expect(detachManualHolding(env, USER_B, acc.id, btc)).rejects.toThrow();
    expect(await listManualHoldingsByAccount(env, USER_A, acc.id, NAMER)).toHaveLength(1);
  });

  it("删账户 → 它的账本级联清(代币行不动,那是参考层)", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await recordManualActivity(env, USER_A, acc.id, btc, { kind: "set", amount: 1, occurredAt: 1 });

    await deleteAccount(env, USER_A, acc.id);

    const acts = await getDb(env).select().from(manualActivity);
    expect(acts.filter((r) => r.accountId === acc.id)).toEqual([]);
    const rows = await getDb(env).select().from(tokensTable).where(eq(tokensTable.id, btc));
    expect(rows).toHaveLength(1);
  });
});
