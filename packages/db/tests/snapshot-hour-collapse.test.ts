import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { AccountStore, accountStoreLayer, SnapshotStore, snapshotStoreLayer } from "../src/queries";
import { user } from "../src/schema/auth";
import { forUser } from "./effect";

// 同步落的快照按钟点折叠(#461):同账户、同一个钟点里只留最后一份。理由见
// `SnapshotStore.write` 的文档注释。
//
// **为什么这组非真 D1 不可**:折叠靠的是「一个 batch 里先删后插」+ 外键的 ON DELETE CASCADE ——
// 前者的原子性、后者会不会真的连余额行一起带走,都只有真库答得了。假 db 上这两条永远是绿的。
const snapshotsOf = forUser(SnapshotStore, snapshotStoreLayer);
const accountsOf = forUser(AccountStore, accountStoreLayer);

const USER = "user-collapse";
const OTHER = "user-collapse-other";
const HOUR = 3_600_000;
// 一个整点(1_800_000_000_000 不是整点,这里取它所在钟点的起点),好把「同钟点/跨钟点」写清楚。
const H0 = Math.floor(1_800_000_000_000 / HOUR) * HOUR;

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

/** 写一张快照,`balances` 条数由 `holdings` 决定(用来看级联有没有把余额行带走)。 */
const write = (
  accountId: string,
  takenAt: number,
  totalUsd: number,
  { collapse = true, holdings = 1, userId = USER } = {},
) =>
  snapshotsOf(userId).write(
    accountId,
    {
      takenAt,
      totalUsd,
      balances: Array.from({ length: holdings }, (_, i) => ({
        amount: 1,
        usdValue: totalUsd / holdings,
        kind: "spot" as const,
        tokenId: `tok-${i}`, // 只要非空(列 NOT NULL,无外键);这组不关心币的身份
      })),
    },
    { collapseSameHour: collapse },
  );

const count = async (sql: string): Promise<number> =>
  (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;

const snapshotRows = () => count("SELECT COUNT(*) AS n FROM snapshots");
const balanceRows = () => count("SELECT COUNT(*) AS n FROM snapshot_balances");

describe("按钟点折叠", () => {
  it("同一钟点内再写一次 → 只剩后写那份", async () => {
    const acc = await account("a");
    await write(acc, H0 + 5 * 60_000, 100);
    await write(acc, H0 + 35 * 60_000, 200);

    expect(await snapshotRows()).toBe(1);
    const [row] = await snapshotsOf(USER).listByAccount(acc);
    expect(row.totalUsd).toBe(200);
    expect(row.takenAt).toBe(H0 + 35 * 60_000);
  });

  it("被折掉那份的余额行一起走(靠 ON DELETE CASCADE,不是手动删)", async () => {
    // 折叠只删 `snapshots` 一张表。余额行若不跟着走就成了永远读不到的孤儿 —— 每小时攒一批,
    // 而省空间正是这件事的动机之一。
    const acc = await account("cascade");
    await write(acc, H0 + 1000, 100, { holdings: 3 });
    expect(await balanceRows()).toBe(3);

    await write(acc, H0 + 2000, 100, { holdings: 2 });
    expect(await snapshotRows()).toBe(1);
    expect(await balanceRows()).toBe(2); // 旧那 3 条没了,只剩新的 2 条
  });

  it("跨钟点不折叠 —— 差一毫秒也算两个钟点", async () => {
    // 按**绝对钟点**切(与读侧同一种切法),不是「距上一张一小时内」:59:59.999 与下一个 00:00.000
    // 只差 1 ms,却分属两个桶,两份都得留着。
    const acc = await account("edge");
    await write(acc, H0 + HOUR - 1, 100);
    await write(acc, H0 + HOUR, 200);

    expect(await snapshotRows()).toBe(2);
  });

  it("整整一小时之后的那份也留着", async () => {
    const acc = await account("next");
    await write(acc, H0 + 30 * 60_000, 100);
    await write(acc, H0 + 90 * 60_000, 200);

    expect(await snapshotRows()).toBe(2);
  });

  it("**默认不折叠** —— 不给开关就照旧追加", async () => {
    // 默认值是这个改动的安全面:导入(`importSnapshot`)转手调的就是这个方法,它恢复的是历史事实。
    const acc = await account("append");
    await write(acc, H0 + 1000, 100, { collapse: false });
    await write(acc, H0 + 2000, 200, { collapse: false });

    expect(await snapshotRows()).toBe(2);
  });

  it("只折叠同一个账户 —— 别的账户同钟点那份不许动", async () => {
    const a = await account("a");
    const b = await account("b");
    await write(a, H0 + 1000, 100);
    await write(b, H0 + 1000, 50);
    await write(a, H0 + 2000, 300);

    expect(await snapshotRows()).toBe(2); // a 的一份 + b 的一份
    const [rowB] = await snapshotsOf(USER).listByAccount(b);
    expect(rowB.totalUsd).toBe(50);
  });

  it("不跨用户 —— 别人同钟点的快照一个都不许碰", async () => {
    const theirs = await account("theirs", OTHER);
    await write(theirs, H0 + 1000, 70, { userId: OTHER });

    const mine = await account("mine");
    await write(mine, H0 + 1000, 100);
    await write(mine, H0 + 2000, 200);

    expect(await snapshotRows()).toBe(2); // 我的一份 + 他的一份
    const [rowTheirs] = await snapshotsOf(OTHER).listByAccount(theirs);
    expect(rowTheirs.totalUsd).toBe(70);
  });

  it("返回的是新那份的 id,旧 id 已经不在库里了", async () => {
    const acc = await account("ids");
    const first = await write(acc, H0 + 1000, 100);
    const second = await write(acc, H0 + 2000, 200);

    expect(second).not.toBe(first);
    const [row] = await snapshotsOf(USER).listByAccount(acc);
    expect(row.id).toBe(second);
  });

  it("总览读到的是折叠后那份", async () => {
    const acc = await account("latest");
    await write(acc, H0 + 1000, 100, { holdings: 2 });
    await write(acc, H0 + 2000, 250, { holdings: 1 });

    const [latest] = await snapshotsOf(USER).latest();
    expect(latest.snapshot.totalUsd).toBe(250);
    expect(latest.balances).toHaveLength(1);
  });
});
