import { env } from "cloudflare:test";
import type { Note } from "@folio/connectors-basic";
import { beforeEach, describe, expect, it } from "vitest";
import { dbFor } from "./db-effect";

// 展示 note 的保留期(#456):cron 每天剪掉窗口外的 note,**只剪 note,不剪 meta**,
// 且每账户最新那张永不剪。
//
// **为什么这组非真 D1 不可**:要验的是「库里到底还剩什么」—— 而剪掉之后读路径拿到的是 null,
// 跟「本来就没有 note」长得一模一样。只有直接去数行数才分得清「真剪了」和「白改一场」。
const USER = "user-prune";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const WINDOW = 7 * DAY;

const note = (title: string): Note[] => [{ title, content: [{ label: "n", value: 1 }] }];
const balanceNote = (title: string): Note => ({ title, content: [{ label: "n", value: 1 }] });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
});

const account = async (label: string) => {
  const id = `acc-${label}`;
  await env.DB.prepare(
    "INSERT INTO accounts (id, user_id, connector_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, USER, "bitcoin", label, Date.now())
    .run();
  return id;
};

/** 写一张带 note 的快照(可选带一条余额,余额自己也有 note + meta)。 */
const snap = (accountId: string, takenAt: number, withBalance = false) =>
  dbFor(USER).snapshots.write(accountId, {
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

const notedSnapshots = () =>
  count("SELECT COUNT(*) AS n FROM snapshots WHERE note IS NOT NULL");
const notedBalances = () =>
  count("SELECT COUNT(*) AS n FROM snapshot_balances WHERE note IS NOT NULL");
const metaRows = () =>
  count("SELECT COUNT(*) AS n FROM snapshot_balances WHERE meta_json IS NOT NULL");

const prune = (olderThan = NOW - WINDOW) => dbFor(USER).snapshots.pruneNotes(olderThan);

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
    const other = "user-prune-other";
    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(other).run();
    const t = Date.now();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(other, other, `${other}@example.com`, 0, t, t)
      .run();
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, connector_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("acc-other", other, "bitcoin", "other", t)
      .run();
    // 另一个用户:两张都很旧,本该被剪掉一张 —— 但这次剪的是 USER
    await dbFor(other).snapshots.write("acc-other", {
      takenAt: NOW - 60 * DAY,
      totalUsd: 1,
      note: note("theirs-old"),
      balances: [],
    });
    await dbFor(other).snapshots.write("acc-other", {
      takenAt: NOW - 50 * DAY,
      totalUsd: 1,
      note: note("theirs-new"),
      balances: [],
    });

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
    const [row] = await dbFor(USER).snapshots.latest();
    expect(row.note?.[0]?.title).toBe(`n@${NOW}`);
  });

  it("导出那条(listPage)拿到的旧快照 note 变空,但行还在", async () => {
    const acc = await account("export");
    await snap(acc, NOW - 30 * DAY);
    await snap(acc, NOW);

    await prune();
    const page = await dbFor(USER).snapshots.listPage(10, 0);
    expect(page).toHaveLength(2); // 快照本身一张都没删
    expect(page.filter((s) => s.note != null)).toHaveLength(1);
  });
});
