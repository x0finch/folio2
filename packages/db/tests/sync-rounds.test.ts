import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import type { SyncRoundRecord } from "../src/domains/sync-rounds";
import { user } from "../src/schema/auth";
import { forDomain, NOW } from "./effect";

// 同步轮的状态是**服务端事实**(ADR 0048),这一层就是它落地的地方。对着真 D1 跑,因为这一层的
// 全部正确性都在 SQL 里:条件 upsert 的 `WHERE`、`json_set` 的路径、以及「轮 id 对不上就落空」。
// 拿假存储测等于把要测的东西换掉。

const rounds = forDomain((db) => db.syncRounds);

const USER_A = "user-a";
const USER_B = "user-b";
const PF = "pf-1";
const TTL = 120_000;
const RETENTION = 7 * 24 * 60 * 60 * 1000;

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

const ACCOUNTS = [
  { id: "acc-1", label: "Binance spot" },
  { id: "acc-2", label: "Kraken" },
];

const open = (
  userId: string,
  roundId: string,
  nowMs = NOW,
  over: { portfolioId?: string; trigger?: "manual" | "cron" } = {},
) =>
  rounds(userId, nowMs).open({
    portfolioId: over.portfolioId ?? PF,
    roundId,
    trigger: over.trigger ?? "manual",
    accounts: ACCOUNTS,
    ttlMs: TTL,
  });

const read = async (userId: string, nowMs = NOW, portfolioId = PF): Promise<SyncRoundRecord> => {
  const got = await rounds(userId, nowMs).get(portfolioId);
  if (Option.isNone(got)) throw new Error("expected a round");
  return got.value;
};

describe("开轮", () => {
  it("写下轮头 + 逐账户明细,心跳到期 = now + ttl", async () => {
    const { round, opened } = await open(USER_A, "r1");
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r1");
    expect(round.trigger).toBe("manual");
    expect(round.startedAt).toBe(NOW);
    expect(round.finishedAt).toBeNull();
    expect(round.expiresAt).toBe(NOW + TTL);
    expect(round.accounts).toEqual({
      "acc-1": { label: "Binance spot", status: "pending" },
      "acc-2": { label: "Kraken", status: "pending" },
    });
    expect(await read(USER_A)).toEqual(round);
  });

  // 幂等 —— 第二个设备(或 cron 撞上手动)看到的是同一轮,不是新开一轮把明细清空。
  it("活轮还在 → 返回同一轮,不覆盖", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 1).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-1",
      status: "synced",
      ttlMs: TTL,
    });

    const { round, opened } = await open(USER_A, "r2", NOW + 2);
    expect(opened).toBe(false);
    expect(round.roundId).toBe("r1");
    expect(round.accounts["acc-1"]?.status).toBe("synced");
  });

  it("上一轮已收官 → 新轮覆盖", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 1).finish({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });

    const { round, opened } = await open(USER_A, "r2", NOW + 2);
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r2");
    expect(round.accounts["acc-1"]?.status).toBe("pending");
  });

  // 未收官但心跳断了 = worker 死了。放着不管的话那个组合就再也开不了轮。
  it("上一轮未收官但已过期 → 新轮覆盖", async () => {
    await open(USER_A, "r1");
    const { round, opened } = await open(USER_A, "r2", NOW + TTL + 1);
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r2");
    expect(round.expiresAt).toBe(NOW + TTL + 1 + TTL);
  });

  // 恰好卡在到期那一刻:`expiresAt` 是「活到这一刻」,now == expiresAt 算已过期(与 cache 的
  // stale 判据同款 `<=`)。断言精确值,不赌墙钟。
  it("到期那一刻算过期", async () => {
    await open(USER_A, "r1");
    const { opened } = await open(USER_A, "r2", NOW + TTL);
    expect(opened).toBe(true);
  });

  it("一组合一键 —— 另一个组合的轮各走各的", async () => {
    await open(USER_A, "r1");
    const { round, opened } = await open(USER_A, "r2", NOW, { portfolioId: "pf-2" });
    expect(opened).toBe(true);
    expect(round.roundId).toBe("r2");
    expect((await read(USER_A)).roundId).toBe("r1");
  });

  it("按用户隔离 —— B 开轮不动 A 的键", async () => {
    await open(USER_A, "r1");
    await open(USER_B, "r2");
    expect((await read(USER_A)).roundId).toBe("r1");
    expect((await read(USER_B)).roundId).toBe("r2");
  });
});

describe("读轮", () => {
  it("从没开过 → none", async () => {
    expect(Option.isNone(await rounds(USER_A).get(PF))).toBe(true);
  });
});

describe("逐账户结果", () => {
  it("落状态、落错误原话,并把心跳续到 now + ttl", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-2",
      status: "failed",
      error: "401 from upstream",
      ttlMs: TTL,
    });

    const round = await read(USER_A);
    expect(round.accounts["acc-2"]).toEqual({
      label: "Kraken",
      status: "failed",
      error: "401 from upstream",
    });
    expect(round.accounts["acc-1"]?.status).toBe("pending");
    expect(round.expiresAt).toBe(NOW + 5 + TTL);
  });

  it("需要凭据也是一档结果,不是失败", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "acc-1",
      status: "needs-keys",
      ttlMs: TTL,
    });
    expect((await read(USER_A)).accounts["acc-1"]?.status).toBe("needs-keys");
  });

  // 漏网竞态:上一轮的 worker 还在跑,而键上已经是新一轮。带轮 id 条件的单语句让它落空成 no-op,
  // 而不是把新轮的明细改花。
  it("轮 id 对不上 → 落空成 no-op", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "STALE",
      accountId: "acc-1",
      status: "synced",
      ttlMs: TTL,
    });

    const round = await read(USER_A);
    expect(round.accounts["acc-1"]?.status).toBe("pending");
    // 心跳也不该被那个陈旧的 worker 续上 —— 续了就等于让一轮死轮永远看起来活着。
    expect(round.expiresAt).toBe(NOW + TTL);
  });

  it("认不出的 accountId → 不往明细里凭空加一条", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 5).settle({
      portfolioId: PF,
      roundId: "r1",
      accountId: "ghost",
      status: "synced",
      ttlMs: TTL,
    });
    expect(Object.keys((await read(USER_A)).accounts).sort()).toEqual(["acc-1", "acc-2"]);
  });
});

describe("收官", () => {
  it("落 finishedAt 并改长保留", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 9).finish({
      portfolioId: PF,
      roundId: "r1",
      retentionMs: RETENTION,
    });

    const round = await read(USER_A);
    expect(round.finishedAt).toBe(NOW + 9);
    expect(round.expiresAt).toBe(NOW + 9 + RETENTION);
  });

  // 整轮没跑起来(取账户 / 取凭据挂了):一个账户的结果都没有,那句话只能挂在轮头上。
  it("整轮失败那一句挂在轮头,不混进逐账户明细", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 9).finish({
      portfolioId: PF,
      roundId: "r1",
      error: "account store exploded",
      retentionMs: RETENTION,
    });

    const round = await read(USER_A);
    expect(round.error).toBe("account store exploded");
    expect(round.accounts["acc-1"]?.status).toBe("pending");
  });

  it("轮 id 对不上 → 落空成 no-op", async () => {
    await open(USER_A, "r1");
    await rounds(USER_A, NOW + 9).finish({
      portfolioId: PF,
      roundId: "STALE",
      retentionMs: RETENTION,
    });
    expect((await read(USER_A)).finishedAt).toBeNull();
  });
});
