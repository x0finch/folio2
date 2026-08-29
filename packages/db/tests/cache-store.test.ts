import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { user } from "../src/schema/auth";
import { forDomain, NOW } from "./effect";

// per-user KV 缓存。**这一条测的不是「能不能写进去」,是「大值会不会把一整批写掉在地上」**。
//
// 预计算(ADR 0049)搬进这张表之后,一个键装的是一整份总览 JSON,而一个组合一次要写十来个键
// —— 这是这张表上唯一一处「一批可能有几 MB」的写。批量超限的下场不是报错然后重试:上层
// (`precomputePortfolio`)把失败咽下去回 `false`,于是那个组合的键永远填不上、页面永远读不到数。
// 所以 `putMany` 按累计字节切批,而这条用例钉的就是「切了之后每个键都真的在」。

const cache = forDomain((db) => db.cache);

const USER = "cache-user";
const OTHER = "cache-other";

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
  await resetUser(USER);
  await resetUser(OTHER);
});

/** 一份「像总览那样大」的值。`kb` 是大致的 KB 数。 */
const blob = (kb: number) => ({
  rows: Array.from({ length: kb * 8 }, (_, i) => ({ i, s: "0123456789abcdef" })),
});

describe("cache putMany", () => {
  it("十个大值一次写下去 → 一个都不少", async () => {
    // 十个 200KB ≈ 2MB,远超一批的字节预算 → 内部切成好几批。
    const writes = Array.from({ length: 10 }, (_, i) => ({
      key: `big:${i}`,
      value: blob(200),
      ttlMs: 60_000,
    }));

    await cache(USER).putMany(writes);

    const got = await cache(USER).getMany(writes.map((w) => w.key));
    expect(got.size).toBe(10);
    // 抽两个真读一下内容 —— 只数条数的话,写进去半截也数得对。
    for (const k of ["big:0", "big:9"]) {
      expect((got.get(k)?.value as ReturnType<typeof blob>).rows).toHaveLength(200 * 8);
    }
  });

  it("一批之内的小写照旧原子(切批只发生在超预算时)", async () => {
    await cache(USER).putMany([
      { key: "a", value: 1, ttlMs: 60_000 },
      { key: "b", value: 2, ttlMs: 60_000 },
    ]);

    const got = await cache(USER).getMany(["a", "b"]);
    expect([got.get("a")?.value, got.get("b")?.value]).toEqual([1, 2]);
  });

  it("各带各的 TTL,过期读出来带 stale", async () => {
    await cache(USER).putMany([
      { key: "fresh", value: 1, ttlMs: 60_000 },
      { key: "old", value: 2, ttlMs: 1 },
    ]);

    // `NOW` 是假时钟的当下(见 ./effect);往后挪一点,短 TTL 那个就过期了。
    const got = await cache(USER, NOW + 1000).getMany(["fresh", "old"]);
    expect(got.get("fresh")?.stale).toBe(false);
    expect(got.get("old")?.stale).toBe(true);
  });

  it("按用户隔离 —— 另一个人写的同名键读不到", async () => {
    await cache(OTHER).putMany([{ key: "mine", value: "theirs", ttlMs: 60_000 }]);

    expect((await cache(USER).getMany(["mine"])).size).toBe(0);
  });
});

// 覆盖式写入:同一个键第二次写要盖掉第一次(预计算每一轮都往同一批键上盖)。
describe("cache putMany 覆盖", () => {
  it("同一个键再写一次 → 读到的是新值", async () => {
    await cache(USER).putMany([{ key: "k", value: "old", ttlMs: 60_000 }]);
    await cache(USER).putMany([{ key: "k", value: "new", ttlMs: 60_000 }]);

    expect((await cache(USER).getMany(["k"])).get("k")?.value).toBe("new");
  });
});
