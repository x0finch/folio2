import { env } from "cloudflare:test";
import { TokenStore } from "@folio/oracle-basic/ports";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
// 包内白盒:query 实现从内部模块直接引(公开面只出 createDb 门面,见 encapsulation.test)。
import { AccountStore, ManualStore } from "../src/queries";
import { manualActivity, tokens as tokensTable } from "../src/schema";
import { user } from "../src/schema/auth";
import { userTokenStoreLayer } from "../src/stores/token";
import { forUser, promisified } from "./effect";

const manualOf = forUser(ManualStore, ManualStore.Default);

const accounts = forUser(AccountStore, AccountStore.Default);

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
  return accounts(userId).create({ connectorId: "manual", label: "M", creds: "{}" });
}

// 建一个该用户的代币行(生产路径是 mint;这里直接用 store,本文件不测认币)。
// `coinId` 给了就顺带挂上那条 ref —— 持仓的 `ref` 就是从 `token_refs` 里当前命名者那行读出来的。
async function mintToken(userId: string, symbol: string, coinId?: string): Promise<string> {
  const store = promisified(TokenStore, userTokenStoreLayer({ userId, namer: NAMER }));
  return store.create({ symbol }, coinId ? [`${NAMER}/issued:${coinId}`] : []);
}

// 同上,但那条 ref 的 localName 由调用方整段给(用来喂非 `issued` 的形状)。
async function mintTokenWithRef(
  userId: string,
  symbol: string,
  localName: string,
): Promise<string> {
  const store = promisified(TokenStore, userTokenStoreLayer({ userId, namer: NAMER }));
  return store.create({ symbol }, [`${NAMER}/${localName}`]);
}

describe("手记持仓(= tokens 行 + 账本)", () => {
  it("持有哪些币由账本推出来;ref 读当前命名者那一行", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    const eth = await mintToken(USER_A, "ETH");
    await manualOf(USER_A).setHoldingDef(btc, { symbol: "BTC" });
    await manualOf(USER_A).setHoldingDef(eth, { symbol: "ETH" });
    // BTC 先开仓 → 序在前(按「什么时候开始持有它」排)。
    await manualOf(USER_A).recordActivity(acc.id, btc, {
      kind: "set",
      amount: 1,
      occurredAt: 100,
    });
    await manualOf(USER_A).recordActivity(acc.id, eth, {
      kind: "set",
      amount: 2,
      occurredAt: 200,
    });

    const rows = await manualOf(USER_A).listHoldings(acc.id, NAMER);
    // **整条 ref,不是右半边。** 只回 `bitcoin` 的话,每个调用方都得把 `<命名者>/issued:` 补回去,
    // 而补它就得知道当前上游是谁 —— 那件事就此漏出 db(#227 评审)。
    expect(rows.map((r) => [r.symbol, r.ref])).toEqual([
      ["BTC", `${NAMER}/issued:bitcoin`],
      ["ETH", null], // 这位命名者还没认出它
    ]);
  });

  // 右半边是什么形状,`ref` 都照原样给整条 —— 本层不替调用方判「这算不算用户选的币」。
  // 挡「拿手敲的名字去认币」是 mint 的活(`hasTrustedSymbol`,ADR 0020 第四轮),不是这个投影的。
  it("ref 不挑形状:合约地址与手敲的名字也照样给整条", async () => {
    const acc = await manualAccount(USER_A);
    const onchain = await mintTokenWithRef(USER_A, "SCAM", "contract:0xdead");
    const typed = await mintTokenWithRef(USER_A, "MYCOIN", "custom:MYCOIN");
    for (const [i, id] of [onchain, typed].entries()) {
      await manualOf(USER_A).recordActivity(acc.id, id, {
        kind: "set",
        amount: 1,
        occurredAt: 100 + i,
      });
    }

    const rows = await manualOf(USER_A).listHoldings(acc.id, NAMER);
    expect(rows.map((r) => [r.symbol, r.ref])).toEqual([
      ["SCAM", `${NAMER}/contract:0xdead`],
      ["MYCOIN", `${NAMER}/custom:MYCOIN`],
    ]);
  });

  it("没有活动的币不算这个账户的持仓", async () => {
    const acc = await manualAccount(USER_A);
    await mintToken(USER_A, "BTC", "bitcoin"); // 代币行在,但这个账户没碰过它
    expect(await manualOf(USER_A).listHoldings(acc.id, NAMER)).toEqual([]);
  });

  // 同一个币被两个手记账户持有 —— 旧模型下这是两条 manual_token 行,现在是一行 tokens + 两份账本。
  it("两个账户持同一个币:各自的数量互不干扰,共用一条代币行", async () => {
    const a1 = await manualAccount(USER_A);
    const a2 = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    await manualOf(USER_A).recordActivity(a1.id, btc, { kind: "set", amount: 1, occurredAt: 1 });
    await manualOf(USER_A).recordActivity(a2.id, btc, { kind: "set", amount: 5, occurredAt: 1 });

    // 各自只看见自己那一份账本 —— 按 token 取活动**必须带 accountId**,否则数量会串。
    expect((await manualOf(USER_A).listActivityByToken(a1.id, btc)).map((r) => r.amount)).toEqual([
      1,
    ]);
    expect((await manualOf(USER_A).listActivityByToken(a2.id, btc)).map((r) => r.amount)).toEqual([
      5,
    ]);
    // 两边都认得这个币,而且是同一行。
    expect((await manualOf(USER_A).listHoldings(a1.id, NAMER))[0].id).toBe(btc);
    expect((await manualOf(USER_A).listHoldings(a2.id, NAMER))[0].id).toBe(btc);
  });

  it("按 token 取活动:按 occurred_at 升序,且带上 (账户, token) 两个键", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await manualOf(USER_A).recordActivity(acc.id, btc, {
      kind: "add",
      amount: 5,
      occurredAt: 200,
    });
    await manualOf(USER_A).recordActivity(acc.id, btc, {
      kind: "set",
      amount: 10,
      occurredAt: 100,
    });
    const rows = await manualOf(USER_A).listActivityByToken(acc.id, btc);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ["set", 10],
      ["add", 5],
    ]);
    expect(rows.every((r) => r.tokenId === btc && r.accountId === acc.id)).toBe(true);
  });

  // 改声明**只动 symbol**:名字 / 图 / 上游 ref 归参考层,而**单价压根不在这里** ——
  // 「这个币值多少」只有账本一个来源(每笔活动的 price),`tokens.self_price` 已没有写者。
  it("改声明只动 symbol —— 名字 / 图 / 上游 ref 归参考层,手记不覆盖", async () => {
    const acc = await manualAccount(USER_A);
    const foo = await mintToken(USER_A, "FOO", "foo-token");
    await manualOf(USER_A).recordActivity(acc.id, foo, { kind: "set", amount: 1, occurredAt: 1 });
    await manualOf(USER_A).setHoldingDef(foo, { symbol: "FOO" });

    const [row] = await manualOf(USER_A).listHoldings(acc.id, NAMER);
    expect([row.symbol, row.ref]).toEqual(["FOO", `${NAMER}/issued:foo-token`]); // ref 没被动
  });

  // 清空一个持仓 = 删该账户对它的活动。**代币行留着** —— 它带着上游 ref / 名字 / 图,
  // 而且别的账户可能还在用。
  it("清空持仓只删这个账户的活动,代币行与别的账户不受影响", async () => {
    const a1 = await manualAccount(USER_A);
    const a2 = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC", "bitcoin");
    await manualOf(USER_A).recordActivity(a1.id, btc, { kind: "set", amount: 1, occurredAt: 1 });
    await manualOf(USER_A).recordActivity(a2.id, btc, { kind: "set", amount: 5, occurredAt: 1 });

    await manualOf(USER_A).detachHolding(a1.id, btc);

    expect(await manualOf(USER_A).listHoldings(a1.id, NAMER)).toEqual([]);
    expect(await manualOf(USER_A).listHoldings(a2.id, NAMER)).toHaveLength(1);
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
      manualOf(USER_B).recordActivity(accB.id, btc, { kind: "set", amount: 1, occurredAt: 1 }),
    ).rejects.toThrow();
    expect(await manualOf(USER_A).listActivityByToken(acc.id, btc)).toEqual([]);
  });

  it("拿别人的账户记活动 → 抛", async () => {
    const acc = await manualAccount(USER_A);
    const tokenB = await mintToken(USER_B, "BTC");
    await expect(
      manualOf(USER_B).recordActivity(acc.id, tokenB, { kind: "set", amount: 1, occurredAt: 1 }),
    ).rejects.toThrow();
  });

  it("别人读不到、改不了、清不掉", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await manualOf(USER_A).recordActivity(acc.id, btc, { kind: "set", amount: 1, occurredAt: 1 });

    await expect(manualOf(USER_B).listHoldings(acc.id, NAMER)).rejects.toThrow();
    await expect(manualOf(USER_B).setHoldingDef(btc, { symbol: "X" })).rejects.toThrow();
    await expect(manualOf(USER_B).detachHolding(acc.id, btc)).rejects.toThrow();
    expect(await manualOf(USER_A).listHoldings(acc.id, NAMER)).toHaveLength(1);
  });

  it("删账户 → 它的账本级联清(代币行不动,那是参考层)", async () => {
    const acc = await manualAccount(USER_A);
    const btc = await mintToken(USER_A, "BTC");
    await manualOf(USER_A).recordActivity(acc.id, btc, { kind: "set", amount: 1, occurredAt: 1 });

    await accounts(USER_A).remove(acc.id);

    const acts = await getDb(env).select().from(manualActivity);
    expect(acts.filter((r) => r.accountId === acc.id)).toEqual([]);
    const rows = await getDb(env).select().from(tokensTable).where(eq(tokensTable.id, btc));
    expect(rows).toHaveLength(1);
  });
});
