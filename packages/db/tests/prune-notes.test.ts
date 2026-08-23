import { env } from "cloudflare:test";
import type { Note } from "@folio/connectors-basic";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { AccountStore, SnapshotStore } from "../src/domains";
import { user } from "../src/schema/auth";
import { forUser } from "./effect";

// 展示 note 的保留期(#456):cron 每天剪掉窗口外的 note,**只剪 note,不剪 meta**,
// 且每账户最新那张永不剪。理由见 `SnapshotStore.pruneNotes` 的文档注释。
//
// **为什么这组非真 D1 不可**:要验的是「库里到底还剩什么」—— 剪掉之后读路径拿到的是 null,
// 跟「本来就没有 note」长得一模一样。只有直接去数行数才分得清「真剪了」和「白改一场」。
//
// 编排那一层(逐用户、窗口怎么算)在 `apps/web/tests/server/prune-notes-all-users.test.ts`。
const snapshotsOf = forUser(SnapshotStore, SnapshotStore.Default);
const accountsOf = forUser(AccountStore, AccountStore.Default);

const USER = "user-prune";
const OTHER = "user-prune-other";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const WINDOW = 7 * DAY;

const note = (title: string): Note[] => [{ title, content: [{ label: "n", value: 1 }] }];
const balanceNote = (title: string): Note => ({ title, content: [{ label: "n", value: 1 }] });

// pool-workers 此版本不隔离每个测试的存储 —— 删 user 行(级联清掉 accounts/snapshots/...)再插回。
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

const account = (label: string, userId = USER) =>
  accountsOf(userId)
    .create({ connectorId: "bitcoin", label, creds: null })
    .then((a) => a.id);

/** 写一张带 note 的快照(可选带一条余额,余额自己也有 note + meta)。 */
const snap = (accountId: string, takenAt: number, withBalance = false, userId = USER) =>
  snapshotsOf(userId).write(accountId, {
    takenAt,
    totalUsd: 1,
    note: note(`n@${takenAt}`),
    balances: withBalance
      ? [
          {
            amount: 1,
            usdValue: 1,
            kind: "defi",
            tokenId: "tok-x", // 只要非空(列 NOT NULL,无外键);这组不关心币的身份
            note: balanceNote(`b@${takenAt}`),
            meta: { protocol: "aave" },
          },
        ]
      : [],
  });

const count = async (sql: string): Promise<number> =>
  (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

const notedSnapshots = () => count("SELECT COUNT(*) AS n FROM snapshots WHERE note IS NOT NULL");
const notedBalances = () =>
  count("SELECT COUNT(*) AS n FROM snapshot_balances WHERE note IS NOT NULL");
const metaRows = () =>
  count("SELECT COUNT(*) AS n FROM snapshot_balances WHERE meta_json IS NOT NULL");

const prune = (olderThan = NOW - WINDOW, userId = USER) =>
  snapshotsOf(userId).pruneNotes(olderThan);

describe("按保留期剪 note", () => {
  it("窗口外的剪掉,窗口内的留着", async () => {
    const acc = await account("a");
    await snap(acc, NOW - 30 * DAY); // 窗口外
    await snap(acc, NOW - 10 * DAY); // 窗口外
    await snap(acc, NOW - 1 * DAY); // 窗口内
    await snap(acc, NOW); // 窗口内 + 最新

    const r = await prune();
    expect(r.snapshots).toBe(2);
    expect(await notedSnapshots()).toBe(2);
  });

  it("**每账户最新那张永不剪** —— 哪怕它整个落在窗口外", async () => {
    // 停了同步的账户(已归档 / 凭据失效)会全部落在窗口外。按时间一刀切会把它唯一那份 note
    // 也剪掉,抽屉里就空了 —— 而界面读的正是这一张。
    const acc = await account("stale");
    await snap(acc, NOW - 100 * DAY);
    await snap(acc, NOW - 90 * DAY); // 这张是最新的,虽然也很旧

    const r = await prune();
    expect(r.snapshots).toBe(1); // 只剪了更早那张
    expect(await notedSnapshots()).toBe(1);
    // 留下的必须是最新那张
    const kept = await env.DB.prepare(
      "SELECT taken_at AS t FROM snapshots WHERE note IS NOT NULL",
    ).first<{ t: number }>();
    expect(kept?.t).toBe(NOW - 90 * DAY);
  });

  it("每个账户各自判最新 —— 不是全局取一张", async () => {
    const a = await account("a");
    const b = await account("b");
    await snap(a, NOW - 50 * DAY);
    await snap(a, NOW - 40 * DAY); // a 的最新
    await snap(b, NOW - 30 * DAY);
    await snap(b, NOW - 20 * DAY); // b 的最新

    await prune();
    expect(await notedSnapshots()).toBe(2); // 两个账户各留一张
  });

  it("只有一张快照的账户 → 一张都不剪", async () => {
    const acc = await account("solo");
    await snap(acc, NOW - 99 * DAY);

    const r = await prune();
    expect(r.snapshots).toBe(0);
    expect(await notedSnapshots()).toBe(1);
  });

  it("余额级 note 一起剪", async () => {
    const acc = await account("bal");
    await snap(acc, NOW - 30 * DAY, true);
    await snap(acc, NOW, true);

    const r = await prune();
    expect(r.balances).toBe(1);
    expect(await notedBalances()).toBe(1);
  });

  it("**`meta_json` 一个都不许动** —— 它是共享逻辑读的,剪了会让历史算错", async () => {
    // 24h 盈亏从 meta 取 DeFi 协议名、balance-kind 从老 perp 行取 role 判 kind。
    // 这条是这个改动的红线:note 能剪是因为「无共享逻辑读」,meta 不是。
    const acc = await account("meta");
    await snap(acc, NOW - 30 * DAY, true);
    await snap(acc, NOW, true);
    expect(await metaRows()).toBe(2);

    await prune();
    expect(await metaRows()).toBe(2); // 剪 note 不碰 meta
  });

  it("幂等:再剪一次不再有变化", async () => {
    const acc = await account("idem");
    await snap(acc, NOW - 30 * DAY, true);
    await snap(acc, NOW, true);

    const first = await prune();
    const second = await prune();
    expect(first.snapshots).toBe(1);
    expect(second.snapshots).toBe(0);
    expect(second.balances).toBe(0);
  });

  it("不跨用户 —— 别人的 note 一个都不许碰", async () => {
    // 另一个用户:两张都很旧,单看时间本该被剪掉一张 —— 但这次剪的是 USER。
    const theirs = await account("theirs", OTHER);
    await snap(theirs, NOW - 60 * DAY, false, OTHER);
    await snap(theirs, NOW - 50 * DAY, false, OTHER);

    const mine = await account("mine");
    await snap(mine, NOW - 30 * DAY);
    await snap(mine, NOW);

    const r = await prune();
    expect(r.snapshots).toBe(1); // 只剪了我的那张
    // 全库还剩 3 张带 note:我的最新 1 张 + 别人的 2 张
    expect(await notedSnapshots()).toBe(3);
  });
});

describe("剪完之后读路径的行为", () => {
  it("界面那条(latest)不受影响 —— 它读的就是最新那张", async () => {
    const acc = await account("read");
    await snap(acc, NOW - 30 * DAY);
    await snap(acc, NOW);

    await prune();
    const [row] = await snapshotsOf(USER).latest();
    expect(row.note?.[0]?.title).toBe(`n@${NOW}`);
  });

  it("导出那条(listPage)拿到的旧快照 note 变空,但行还在", async () => {
    const acc = await account("export");
    await snap(acc, NOW - 30 * DAY);
    await snap(acc, NOW);

    await prune();
    const page = await snapshotsOf(USER).listPage(10, 0);
    expect(page).toHaveLength(2); // 快照本身一张都没删
    expect(page.filter((s) => s.note != null)).toHaveLength(1);
  });
});
