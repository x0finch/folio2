import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createUserCacheStore, createUserTokenPriceStore, createUserTokenStore } from "../src";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";
import {
  accounts,
  globalTokenRefIndex,
  snapshotBalances,
  snapshots,
  tokenDailyPrices,
  tokenRefs,
  tokens,
} from "../src/schema";

// 新参考层三个 per-user store 的真 D1 测试(#199)。
//
// **为什么非要对着真表跑一遍**:oracle 那几片全用内存假实现,fake 的 refs 是个 `Map` ——
// 一批里插两条相同的 ref 会被悄悄覆盖,真表上 `token_refs` 的主键会冲突、整批写失败。
// #212 里那个 `coingecko/<id>` 的 bug 就是这么藏了一阵。这里把 mint 会走到的形状对着约束重跑。

const USER_A = "u-a";
const USER_B = "u-b";
const NAMER = "coingecko"; // 上游自报的 id;store 只拿它判「认出来了没」
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_UP = "coingecko/issued:usd-coin";

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
  const db = getDb(env);
  // 删 user 级联清掉 tokens / token_refs / user_cache;两张全局表没有 userId,单独清。
  await resetUser(USER_A);
  await resetUser(USER_B);
  await db.batch([db.delete(globalTokenRefIndex), db.delete(tokenDailyPrices)]);
});

const storeFor = (userId: string, namer = NAMER) =>
  createUserTokenStore(env, { userId, namer, now: () => 1000 });

const seed = (symbol: string, name?: string, providerLogo?: string) => ({
  symbol,
  name,
  providerLogo,
});

describe("建行与幂等", () => {
  it("建行 + 挂 ref;按 ref 查得回,按 id 读得出", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC", "USD Coin", "p.png"), [USDC_ETH, USDC_UP]);

    const hits = await store.findByRefs([USDC_ETH, USDC_UP]);
    expect(hits.get(USDC_ETH)).toEqual({ tokenId: id, linked: true });
    expect(hits.get(USDC_UP)).toEqual({ tokenId: id, linked: true });

    const info = await store.getById(id);
    expect(info).toMatchObject({ id, symbol: "USDC", name: "USD Coin", providerLogo: "p.png" });
    // ref = 当前上游对它的命名(有上游那一档的 ref 行才有)。
    expect(info?.ref).toBe(USDC_UP);
  });

  it("只有 provider 那条 ref → 上游还没认出来,ref 为 null、linked 为 false", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("SCAM"), [USDC_ETH]);
    expect((await store.getById(id))?.ref).toBeNull();
    expect((await store.findByRefs([USDC_ETH])).get(USDC_ETH)).toEqual({
      tokenId: id,
      linked: false,
    });
  });

  // 账户是并发跑的,同一条 ref 会被同时 mint。fake 用 Map 时这条永远绿,真表上靠主键 + upsert-then-read。
  it("并发建同一条 ref → 只出一行,两次调用返回同一个 id", async () => {
    const store = storeFor(USER_A);
    const [a, b] = await Promise.all([
      store.create(seed("USDC"), [USDC_ETH, USDC_UP]),
      store.create(seed("USDC"), [USDC_ETH, USDC_UP]),
    ]);
    expect(a).toBe(b);
    const rows = await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A));
    expect(rows).toHaveLength(1); // 抢输的那一方把自己建的孤行删掉了
  });

  // 这正是 #212 修掉的那个 bug 的真表版本:mint 去重之前会往一批里塞两条相同 ref。
  it("同一批里给两条相同的 ref → 不撞主键,照样建成一行", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP, USDC_UP]);
    expect((await store.findByRefs([USDC_UP])).get(USDC_UP)?.tokenId).toBe(id);
  });

  it("读不懂的 ref 不进表 —— 建行照成,只是没有 ref 行", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("FOO"), ["nonsense"]);
    expect((await store.findByRefs(["nonsense"])).size).toBe(0);
    expect((await store.getById(id))?.symbol).toBe("FOO");
  });
});

describe("按用户隔离", () => {
  it("两个用户各持有 USDC → 各一行、各自的 ref 行,互相看不见", async () => {
    const a = storeFor(USER_A);
    const b = storeFor(USER_B);
    const idA = await a.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    const idB = await b.create(seed("USDC"), [USDC_ETH, USDC_UP]);

    expect(idA).not.toBe(idB);
    expect((await a.findByRefs([USDC_UP])).get(USDC_UP)?.tokenId).toBe(idA);
    expect((await b.findByRefs([USDC_UP])).get(USDC_UP)?.tokenId).toBe(idB);
    // 拿别人的 id 读不出来。
    expect(await a.getById(idB)).toBeUndefined();
  });
});

describe("多链归一", () => {
  it("同一个币的第二条链 ref 只加一行,不建新 Token", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    expect(await store.linkRef(id, USDC_ARB)).toBe(id);

    const hits = await store.findByRefs([USDC_ETH, USDC_ARB, USDC_UP]);
    expect(new Set([...hits.values()].map((h) => h.tokenId))).toEqual(new Set([id]));
    const rows = await getDb(env).select().from(tokens).where(eq(tokens.userId, USER_A));
    expect(rows).toHaveLength(1);
  });

  it("linkRef 幂等:这条 ref 已有主 → 返回它的主,不改指", async () => {
    const store = storeFor(USER_A);
    const mine = await store.create(seed("USDC"), [USDC_ETH]);
    const other = await store.create(seed("ETH"), ["evm:1/native"]);
    expect(await store.linkRef(other, USDC_ETH)).toBe(mine);
  });

  // 「一个 Token 在一个命名者下最多一条 ref」= 一个 Token 只对一个上游币。
  // 应用层 linkRef 先挡一道,DB 层再由唯一索引 (user_id, token_id, namer) 兜底(见下一个用例)。
  it("一个 Token 已有上游那一档 → 不许再加第二条", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    await store.linkRef(id, "coingecko/issued:tether"); // 想给同一行挂第二个上游币
    expect((await store.getById(id))?.ref).toBe(USDC_UP); // 还是原来那个
    expect((await store.findByRefs(["coingecko/issued:tether"])).size).toBe(0);
  });

  // 应用层的先查后写在 Workers 多实例下不是原子的 —— 唯一索引是唯一真正防竞态的那道。
  // 绕开 store 直接对表插两条「同 (user_id, token_id, namer)、不同 local_name」验证约束确实在。
  it("唯一索引挡住「同一 Token 一个命名者两条 ref」—— 第二条直插报错", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]); // coingecko/issued:usd-coin
    await expect(
      db.insert(tokenRefs).values({
        userId: USER_A,
        namer: "coingecko",
        localName: "issued:tether", // 同 Token、同命名者、不同币 → 撞唯一索引
        tokenId: id,
      }),
    ).rejects.toThrow();
  });
});

describe("合并", () => {
  it("ref 改指、历史快照 token_id 一并改指、旧行删除", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    const orphan = await store.create(seed("USDC", undefined, "p.png"), [USDC_ETH]);
    const owner = await store.create(seed("USDC", "USD Coin"), [USDC_UP]);

    // 造一条指向旧行的历史快照余额。
    await db.insert(accounts).values({
      id: "acc-1",
      userId: USER_A,
      connectorId: "evm" as never,
      label: "w",
      createdAt: 1,
    });
    await db
      .insert(snapshots)
      .values({ id: "snap-1", accountId: "acc-1", takenAt: 1, totalUsd: 1 });
    await db.insert(snapshotBalances).values({
      id: "bal-1",
      snapshotId: "snap-1",
      amount: 1,
      usdValue: 1,
      kind: "spot",
      tokenId: orphan,
    });

    await store.merge(orphan, owner);

    expect((await store.findByRefs([USDC_ETH])).get(USDC_ETH)?.tokenId).toBe(owner);
    expect(await store.getById(orphan)).toBeUndefined();
    const bal = await db
      .select({ tokenId: snapshotBalances.tokenId })
      .from(snapshotBalances)
      .where(eq(snapshotBalances.id, "bal-1"));
    expect(bal[0].tokenId).toBe(owner); // 身份可变、金额不变
    // 旧行的 provider 图是展示回退链的一档,别随行一起丢。
    expect((await store.getById(owner))?.providerLogo).toBe("p.png");
  });

  it("两边有同一条 ref → 不撞主键(旧行那条先删掉)", async () => {
    const store = storeFor(USER_A);
    const a = await store.create(seed("USDC"), [USDC_ETH]);
    const b = await store.create(seed("USDC"), [USDC_ARB]);
    await store.linkRef(b, USDC_UP);
    // 人为让两行都有 evm:1 那条?—— linkRef 会返回既有主,所以造法是各自独立建后合并。
    await store.merge(a, b);
    expect((await store.findByRefs([USDC_ETH, USDC_ARB])).size).toBe(2);
    expect(await store.getById(a)).toBeUndefined();
  });

  // 两边各有一条**同命名者、不同币**的 ref(各自被上游认成不同 coingecko coin)。改指会让 into
  // 在同命名者下出现两条 → 撞唯一索引。merge 按命名者去重、留 into 那份,收敛到一个上游币、不抛。
  it("两边各有一条同命名者不同币的 ref → 留 into 的,不撞唯一索引", async () => {
    const store = storeFor(USER_A);
    const from = await store.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    const into = await store.create(seed("BTC"), ["coingecko/issued:wrapped-bitcoin"]);

    await store.merge(from, into);

    expect(await store.getById(from)).toBeUndefined();
    // into 保住自己那份;from 的 coingecko/bitcoin 被剔掉,不并入。
    expect((await store.getById(into))?.ref).toBe("coingecko/issued:wrapped-bitcoin");
    expect((await store.findByRefs(["coingecko/issued:bitcoin"])).size).toBe(0);
    const refs = await getDb(env)
      .select({ tokenId: tokenRefs.tokenId })
      .from(tokenRefs)
      .where(eq(tokenRefs.tokenId, into));
    expect(refs).toHaveLength(1); // 一个 Token 在 coingecko 下就一条
  });

  // 历史日价按 tokenRef 全局存,与 token_id 无关 → 合并不该让曲线缺一格(#199 定案)。
  it("合并不影响历史曲线 —— 赢家读到的日价与合并前一致", async () => {
    const store = storeFor(USER_A);
    const prices = createUserTokenPriceStore(env, {
      userId: USER_A,
      namer: NAMER,
      now: () => 1000,
    });
    const orphan = await store.create(seed("USDC"), [USDC_ETH]);
    const owner = await store.create(seed("USDC"), [USDC_UP]);
    await prices.putDaily(owner, [{ dayBucket: 20180, unitPrice: 1 }]);

    const before = await prices.getDaily(owner, [20180]);
    await store.merge(orphan, owner);
    expect(await prices.getDaily(owner, [20180])).toEqual(before);
  });
});

describe("fillInfo 只填空槽", () => {
  it("已有值的字段不动,空的才填", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC", "Provider Name", "p.png"), [USDC_ETH]);
    await store.fillInfo(id, { name: "Upstream Name", logo: "u.png", providerLogo: "other.png" });
    const info = await store.getById(id);
    expect(info?.name).toBe("Provider Name"); // 已有 → 不覆盖
    expect(info?.providerLogo).toBe("p.png"); // 已有 → 不覆盖
    expect(info?.logo).toBe("u.png"); // 原为空 → 填上
  });
});

// `putInfo` 是 `fillInfo` 的对面:上游说了算。链上合约的 symbol 是部署者写的、可能与上游实际
// 叫法不一致(MATIC→POL),不覆盖的话同一个币在链上侧与交易所侧显示成两个名字。
describe("putInfo 覆盖上游那三个字段", () => {
  it("symbol/name/logo 一律覆盖,连接器自带的备用图不动", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("MATIC", "Matic Network", "zerion.png"), [USDC_ETH]);

    await store.putInfo(
      [{ tokenId: id, symbol: "POL", name: "POL (ex-MATIC)", logo: "pol.png" }],
      60_000,
    );

    const info = await store.getById(id);
    expect(info).toMatchObject({
      symbol: "POL",
      name: "POL (ex-MATIC)",
      logo: "pol.png",
      providerLogo: "zerion.png", // 上游无权覆盖备用槽
    });
  });

  it("上游这次没给图 → 保留原有的,不擦成 null", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("OLD"), [USDC_ETH]);
    await store.putInfo([{ tokenId: id, symbol: "OLD", name: "Old", logo: "keep.png" }], 60_000);
    await store.putInfo([{ tokenId: id, symbol: "NEW", name: "New" }], 60_000);
    expect(await store.getById(id)).toMatchObject({ symbol: "NEW", logo: "keep.png" });
  });

  it("info TTL:建行即 stale;刷过转 fresh;过期又变 stale —— 但**过期不删、照样给**", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_ETH]);
    // 建行时 info_expires_at = now → 已过期:行是拿连接器报的那份建的,上游还没覆盖过。
    expect((await store.getById(id))?.infoStale).toBe(true);

    await store.putInfo([{ tokenId: id, symbol: "USDC", name: "USD Coin" }], 60_000);
    expect((await store.getById(id))?.infoStale).toBe(false);

    // 时钟走到 TTL 之后(now 是注入的 1000 → 用另一个 store 实例看同一行)。
    const later = createUserTokenStore(env, { userId: USER_A, namer: NAMER, now: () => 100_000 });
    const info = await later.getById(id);
    expect(info?.infoStale).toBe(true);
    expect(info?.name).toBe("USD Coin"); // 仍然给 —— 门控读会让 logo 代理端点 404
  });

  it("拿别人的 tokenId 调 → 一行都不改(userId 在 where 里)", async () => {
    const mine = await storeFor(USER_A).create(seed("USDC"), [USDC_ETH]);
    await storeFor(USER_B).putInfo([{ tokenId: mine, symbol: "HACKED", name: "Hacked" }], 60_000);
    expect((await storeFor(USER_A).getById(mine))?.symbol).toBe("USDC");
  });

  it("空数组 → 不发语句", async () => {
    await expect(storeFor(USER_A).putInfo([], 60_000)).resolves.toBeUndefined();
  });
});

// 上游与交易所改名的时间不一致 → 收敛发生的那一刻就是「叫法变了」的证据。
// 身份发生变化的写入顺带把 info 标成该刷,否则显示名最长滞后一个 INFO_TTL_MS(30d)。
describe("身份变化把 info 标成该刷", () => {
  const freshen = async (store: ReturnType<typeof storeFor>, id: string) => {
    await store.putInfo([{ tokenId: id, symbol: "MATIC", name: "Matic Network" }], 60_000);
    expect((await store.getById(id))?.infoStale).toBe(false);
  };

  it("linkRef 真加了一条 ref → 标脏", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("MATIC"), [USDC_ETH]);
    await freshen(store, id);

    await store.linkRef(id, USDC_ARB);
    expect((await store.getById(id))?.infoStale).toBe(true);
  });

  it("linkRef 的两条早退路径都不写 → 不标脏", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("MATIC"), [USDC_ETH]);
    await store.linkRef(id, USDC_UP); // 先占上本源那一档
    await freshen(store, id);

    await store.linkRef(id, USDC_ETH); // 这条 ref 已有主 → 早退
    expect((await store.getById(id))?.infoStale).toBe(false);
    await store.linkRef(id, "coingecko/issued:other-coin"); // 该命名者下已有别的叫法 → 不加第二条
    expect((await store.getById(id))?.infoStale).toBe(false);
  });

  it("merge 之后赢家标脏 —— 它留的是自己那份(可能是旧)名字", async () => {
    const store = storeFor(USER_A);
    const winner = await store.create(seed("MATIC", "Matic Network"), [USDC_ETH]);
    const loser = await store.create(seed("POL"), [USDC_ARB]);
    await freshen(store, winner);

    await store.merge(loser, winner);
    const info = await store.getById(winner);
    expect(info?.symbol).toBe("MATIC"); // 赢家的名字没被输家改掉
    expect(info?.infoStale).toBe(true); // 但会被标成该刷
  });
});

describe("价 facet", () => {
  it("写 → 读回;过期不删,读出带 stale", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]);
    const prices = createUserTokenPriceStore(env, {
      userId: USER_A,
      namer: NAMER,
      now: () => 1000,
    });

    await prices.put([{ tokenId: id, unitPrice: 1, change24h: 0.1, asOf: 900 }], 500);
    const fresh = (await prices.getByIds([id])).get(id);
    expect(fresh).toMatchObject({ unitPrice: 1, change24h: 0.1, asOf: 900, stale: false });

    // 时钟往后 → 同一行读出 stale,值还在。
    const later = createUserTokenPriceStore(env, {
      userId: USER_A,
      namer: NAMER,
      now: () => 9999,
    });
    expect((await later.getByIds([id])).get(id)).toMatchObject({ unitPrice: 1, stale: true });
  });

  it("尚无价的行不出现在结果里", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]);
    const prices = createUserTokenPriceStore(env, { userId: USER_A, namer: NAMER });
    expect((await prices.getByIds([id])).size).toBe(0);
  });

  // 喂刷价的端点不含排名;`?? null` 会把持仓币的排名反复抹掉。
  it("刷价不抹掉已有的市值排名", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    const id = await store.create(seed("USDC"), [USDC_UP]);
    await db.update(tokens).set({ marketCapRank: 7 }).where(eq(tokens.id, id));
    const prices = createUserTokenPriceStore(env, { userId: USER_A, namer: NAMER });
    await prices.put([{ tokenId: id, unitPrice: 1, asOf: 1 }], 500);
    expect((await prices.getByIds([id])).get(id)?.marketCapRank).toBe(7);
  });
});

describe("历史日价按 tokenRef 全局存", () => {
  it("两个用户的同一个币共用同一批行 —— 谁先写,另一个直接读到", async () => {
    const a = storeFor(USER_A);
    const b = storeFor(USER_B);
    const idA = await a.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    const idB = await b.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    expect(idA).not.toBe(idB);

    const pricesA = createUserTokenPriceStore(env, { userId: USER_A, namer: NAMER });
    const pricesB = createUserTokenPriceStore(env, { userId: USER_B, namer: NAMER });
    await pricesA.putDaily(idA, [{ dayBucket: 20180, unitPrice: 42000 }]);

    // B 一个字都没写,却读得到 —— 这就是全局存的全部意义。
    expect(await pricesB.getDaily(idB, [20180])).toEqual(new Map([[20180, 42000]]));
    // 表里确实只有一行。
    const rows = await getDb(env).select().from(tokenDailyPrices);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenRef).toBe("coingecko/issued:bitcoin");
  });

  it("上游还没认出来的币没有全局键 → 读空、写跳过,不抛", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("SCAM"), [USDC_ETH]); // 只有 provider 那条 ref
    const prices = createUserTokenPriceStore(env, { userId: USER_A, namer: NAMER });
    await prices.putDaily(id, [{ dayBucket: 20180, unitPrice: 1 }]);
    expect((await prices.getDaily(id, [20180])).size).toBe(0);
    expect(await getDb(env).select().from(tokenDailyPrices)).toHaveLength(0);
  });

  it("同一个 (ref, 日) 再写一次是覆盖,不是重复行", async () => {
    const store = storeFor(USER_A);
    const id = await store.create(seed("BTC"), ["coingecko/issued:bitcoin"]);
    const prices = createUserTokenPriceStore(env, { userId: USER_A, namer: NAMER });
    await prices.putDaily(id, [{ dayBucket: 20180, unitPrice: 1 }]);
    await prices.putDaily(id, [{ dayBucket: 20180, unitPrice: 2 }]);
    expect(await prices.getDaily(id, [20180])).toEqual(new Map([[20180, 2]]));
  });
});

describe("per-user 缓存", () => {
  it("写 → 读回;过期不删,读出带 stale;按用户隔离", async () => {
    const a = createUserCacheStore(env, { userId: USER_A, now: () => 1000 });
    const b = createUserCacheStore(env, { userId: USER_B, now: () => 1000 });
    await a.put("fx:EUR", 1.08, 500);

    expect(await a.get("fx:EUR")).toEqual({ value: 1.08, stale: false });
    expect(await b.get("fx:EUR")).toBeUndefined(); // 别人的缓存看不见

    const later = createUserCacheStore(env, { userId: USER_A, now: () => 9999 });
    expect(await later.get("fx:EUR")).toEqual({ value: 1.08, stale: true });
  });

  it("同一个键再写是覆盖", async () => {
    const a = createUserCacheStore(env, { userId: USER_A, now: () => 1000 });
    await a.put("warm", [{ ref: "coingecko/issued:bitcoin" }], 500);
    await a.put("warm", [{ ref: "coingecko/issued:ethereum" }], 500);
    expect(await a.get("warm")).toMatchObject({ value: [{ ref: "coingecko/issued:ethereum" }] });
  });

  it("没有的键 → undefined", async () => {
    const a = createUserCacheStore(env, { userId: USER_A });
    expect(await a.get("platform:evm:1")).toBeUndefined();
  });

  it("批量读:一条 IN 拿多个键,miss 的不出现;按用户隔离", async () => {
    const a = createUserCacheStore(env, { userId: USER_A, now: () => 1000 });
    const b = createUserCacheStore(env, { userId: USER_B, now: () => 1000 });
    await a.putMany([
      { key: "platform:evm:1", value: { name: "Ethereum" }, ttlMs: 500 },
      { key: "platform:solana", value: { name: "Solana" }, ttlMs: 500 },
    ]);

    const hits = await a.getMany(["platform:evm:1", "platform:solana", "platform:nope"]);
    expect([...hits.keys()].sort()).toEqual(["platform:evm:1", "platform:solana"]);
    expect(hits.get("platform:evm:1")?.value).toEqual({ name: "Ethereum" });
    expect(await b.getMany(["platform:evm:1"])).toEqual(new Map()); // 别人的看不见
  });

  it("批量写:**每个键各带自己的 TTL**(平台命中长、否定短就靠这个)", async () => {
    const a = createUserCacheStore(env, { userId: USER_A, now: () => 1000 });
    await a.putMany([
      { key: "platform:evm:1", value: { name: "Ethereum" }, ttlMs: 5000 },
      { key: "platform:nochain", value: { name: null }, ttlMs: 100 },
    ]);

    // now=2000:长 TTL 那条还新鲜,短 TTL 那条已 stale —— 过期不删,照样读得出来。
    const later = createUserCacheStore(env, { userId: USER_A, now: () => 2000 });
    const hits = await later.getMany(["platform:evm:1", "platform:nochain"]);
    expect(hits.get("platform:evm:1")?.stale).toBe(false);
    expect(hits.get("platform:nochain")).toEqual({ value: { name: null }, stale: true });
  });

  it("批量写是覆盖;空批次是 no-op(不炸)", async () => {
    const a = createUserCacheStore(env, { userId: USER_A, now: () => 1000 });
    await a.putMany([{ key: "fx:EUR", value: 1.08, ttlMs: 500 }]);
    await a.putMany([{ key: "fx:EUR", value: 1.09, ttlMs: 500 }]);
    expect(await a.get("fx:EUR")).toEqual({ value: 1.09, stale: false });

    await expect(a.putMany([])).resolves.toBeUndefined();
    expect(await a.getMany([])).toEqual(new Map());
  });

  it("批量读超过分块大小仍拿全(D1 绑定参数上限 → 分块 IN)", async () => {
    const a = createUserCacheStore(env, { userId: USER_A, now: () => 1000 });
    const keys = Array.from({ length: 200 }, (_, i) => `platform:evm:${i}`);
    await a.putMany(keys.map((key, i) => ({ key, value: { name: `c${i}` }, ttlMs: 500 })));

    const hits = await a.getMany(keys);
    expect(hits.size).toBe(200);
    expect(hits.get("platform:evm:199")?.value).toEqual({ name: "c199" });
  });
});

describe("删用户级联", () => {
  it("删 user 一并清掉他的代币行、ref 行、缓存 —— 不撞外键", async () => {
    const db = getDb(env);
    const store = storeFor(USER_A);
    await store.create(seed("USDC"), [USDC_ETH, USDC_UP]);
    await createUserCacheStore(env, { userId: USER_A }).put("warm", [], 500);

    // snapshot_balances.token_id 刻意没有外键,正是为了让这一步不受历史行牵制(见 schema.ts)。
    await expect(db.delete(user).where(eq(user.id, USER_A))).resolves.toBeDefined();
    expect(await db.select().from(tokens).where(eq(tokens.userId, USER_A))).toHaveLength(0);
  });
});
