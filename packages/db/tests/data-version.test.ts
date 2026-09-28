import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { tokens as tokensTable, userDataVersion } from "../src/schema";
import { user } from "../src/schema/auth";
import { forDomain, forOracle } from "./effect";

// 数据版本号(FOL-94):用户看得见的数据一变它就 +1,浏览器据此决定要不要重拉。
// 抬它的是迁移 0010 的触发器,不是各个 op —— 所以这里测两件事:
//   ① **覆盖面**:按 sqlite_master 数,每张带归属列的表要么挂了触发器、要么在豁免名单上写着理由;
//      新加一张表而没决定它,这条先红。
//   ② **行为**:主要的写 op 各抬一次、读不抬、跨用户不串、删用户不被触发器卡住。

const dataVersion = forDomain((db) => db.dataVersion);
const accounts = forDomain((db) => db.accounts);
const snapshots = forDomain((db) => db.snapshots);
const tags = forDomain((db) => db.tags);
const tabPins = forDomain((db) => db.tabPins);
const portfolios = forDomain((db) => db.portfolios);
const settings = forDomain((db) => db.settings);
const manual = forDomain((db) => db.manual);
const tokensOf = forOracle((db) => db.tokens);
const pricesOf = forOracle((db) => db.tokenPrices);

const USER_A = "dv-user-a";
const USER_B = "dv-user-b";
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

// 跑一个写,返回版本号抬了多少。
async function bumpOf(userId: string, write: () => Promise<unknown>): Promise<number> {
  const before = await dataVersion(userId).get();
  await write();
  return (await dataVersion(userId).get()) - before;
}

const manualAccount = (userId: string) =>
  accounts(userId).create({ connectorId: "manual", label: "M", creds: "{}" });

describe("覆盖面(sqlite_master)", () => {
  // 挂了触发器的表 → 挂了哪几种。**改这张表就是改「什么算用户看得见的写」**,review 时看这里。
  const COVERED: Record<string, string[]> = {
    accounts: ["insert", "update", "delete"],
    portfolios: ["insert", "update", "delete"],
    portfolio_accounts: ["insert", "update", "delete"],
    tags: ["insert", "update", "delete"],
    account_tags: ["insert", "update", "delete"],
    tab_pins: ["insert", "update", "delete"],
    user_settings: ["insert", "update", "delete"],
    manual_activity: ["insert", "update", "delete"],
    // 快照唯一的 UPDATE 是清旧快照的 note(pruneNotes),那几张早就不在屏幕上了。
    snapshots: ["insert", "delete"],
    // 只在用户能改的三列真的变了时(见迁移里的 WHEN)。
    tokens: ["update"],
  };
  // 带归属列、**刻意不挂**的表(理由见 schema 里 `userDataVersion` 那段)。
  const EXEMPT = new Set([
    "snapshot_balances",
    "account_daily_totals",
    "user_cache",
    "token_refs",
    "user_data_version",
    // better-auth 的表:会话 / 登录方式,不是看板数据。
    "session",
    "account",
    "passkey",
  ]);
  const OWNER_COLUMNS = ["user_id", "account_id", "portfolio_id", "snapshot_id", "tag_id"];

  it("触发器正好是 COVERED 那一份", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all<{ name: string; tbl_name: string }>();
    const expected = Object.entries(COVERED)
      .flatMap(([table, events]) => events.map((e) => `${table}_data_version_${e}`))
      .sort();
    expect(results.map((r) => r.name)).toEqual(expected);
  });

  it("每张带归属列的表都有了决定:挂触发器,或在豁免名单上", async () => {
    // D1 不许表值函数 `pragma_table_info(…)`,逐表问 `PRAGMA table_info`。
    const { results: tables } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'",
    ).all<{ name: string }>();
    const owned: string[] = [];
    for (const { name } of tables) {
      const { results: cols } = await env.DB.prepare(`PRAGMA table_info(\`${name}\`)`).all<{
        name: string;
      }>();
      if (cols.some((c) => OWNER_COLUMNS.includes(c.name))) owned.push(name);
    }
    expect(owned).toContain("accounts"); // 探针本身没坏
    expect(owned.filter((t) => !(t in COVERED) && !EXEMPT.has(t))).toEqual([]);
  });
});

describe("行为", () => {
  it("没写过 → 0", async () => {
    expect(await dataVersion(USER_A).get()).toBe(0);
  });

  it("账户的建 / 改名 / 归档 / 换凭据 / 删 各抬", async () => {
    let acc: { id: string } | undefined;
    expect(
      await bumpOf(USER_A, async () => {
        acc = await manualAccount(USER_A);
      }),
    ).toBeGreaterThan(0);
    const id = acc!.id;
    expect(await bumpOf(USER_A, () => accounts(USER_A).rename(id, "N"))).toBe(1);
    expect(await bumpOf(USER_A, () => accounts(USER_A).setArchived(id, true))).toBe(1);
    expect(await bumpOf(USER_A, () => accounts(USER_A).setCredentials(id, "{}"))).toBe(1);
    expect(await bumpOf(USER_A, () => accounts(USER_A).remove(id))).toBeGreaterThan(0);
  });

  it("写一张快照 = 抬一次,与它有几行余额无关(余额行不挂触发器)", async () => {
    const acc = await manualAccount(USER_A);
    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    const balance = { amount: 1, usdValue: 1, kind: "spot" as const, tokenId };
    expect(
      await bumpOf(USER_A, () =>
        snapshots(USER_A).write(acc.id, {
          takenAt: 10_000,
          totalUsd: 3,
          balances: [balance, balance, balance],
        }),
      ),
    ).toBe(1);
  });

  it("标签 / Tab / 组合 / 设置 / 手记活动 各抬", async () => {
    const acc = await manualAccount(USER_A);
    const [portfolio] = await portfolios(USER_A).list();
    let tagId = "";
    expect(
      await bumpOf(USER_A, async () => {
        tagId = (await tags(USER_A).create({ portfolioId: portfolio!.id, name: "t" })).id;
      }),
    ).toBe(1);
    expect(await bumpOf(USER_A, () => tags(USER_A).attach(acc.id, tagId))).toBe(1);
    expect(await bumpOf(USER_A, () => tabPins(USER_A).create({ kind: "tag", tagId }))).toBe(1);
    expect(await bumpOf(USER_A, () => portfolios(USER_A).create({ name: "p2" }))).toBe(1);
    expect(await bumpOf(USER_A, () => settings(USER_A).update({ hideBalances: true }))).toBe(1);

    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    expect(
      await bumpOf(USER_A, () =>
        manual(USER_A).recordActivity(acc.id, tokenId, { kind: "set", amount: 1, occurredAt: 1 }),
      ),
    ).toBe(1);
  });

  it("代币行:用户改名抬;同值重写 / 刷价 不抬", async () => {
    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    expect(
      await bumpOf(USER_A, () => manual(USER_A).setHoldingDef(tokenId, { symbol: "XBT" })),
    ).toBe(1);
    expect(
      await bumpOf(USER_A, () => manual(USER_A).setHoldingDef(tokenId, { symbol: "XBT" })),
    ).toBe(0);
    expect(
      await bumpOf(USER_A, () =>
        pricesOf(USER_A, NAMER).put([{ tokenId, unitPrice: 42, asOf: 1 }], 60_000),
      ),
    ).toBe(0);
  });

  it("读不抬;一个用户的写不抬别人", async () => {
    await manualAccount(USER_A);
    expect(await bumpOf(USER_A, () => accounts(USER_A).list())).toBe(0);
    expect(await dataVersion(USER_B).get()).toBe(0);
  });

  it("删用户:级联删不被触发器卡住,版本行随之消失", async () => {
    const acc = await manualAccount(USER_A);
    const tokenId = await tokensOf(USER_A, NAMER).create({ symbol: "BTC" }, []);
    await snapshots(USER_A).write(acc.id, {
      takenAt: 10_000,
      totalUsd: 1,
      balances: [{ amount: 1, usdValue: 1, kind: "spot", tokenId }],
    });
    const db = getDb(env);
    await db.delete(user).where(eq(user.id, USER_A));
    expect(
      await db.select().from(userDataVersion).where(eq(userDataVersion.userId, USER_A)),
    ).toEqual([]);
    expect(await db.select().from(tokensTable).where(eq(tokensTable.userId, USER_A))).toEqual([]);
  });
});
