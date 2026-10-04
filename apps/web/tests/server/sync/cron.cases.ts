import { env } from "cloudflare:test";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutAllUsers, openSyncRound } from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound, type Outbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// cron 按**组合**分区开轮(ADR 0048),**只开轮 + 投消息,不跑**(FOL-86)。真同步在队列 consumer 里
// 一个账户一次调用(见 ../jobs/consume.cases.ts)。这里钉的是开轮的形状,以及「这一步一发上游都不打」。

describe("sync/cron(fan-out)", () => {
  const USER = "h-sync-cron";
  let outbound: Outbound;
  let sent: Enqueued[];

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const roundOf = async (portfolioId: string) => {
    const got = await db(USER).syncRounds.get(portfolioId);
    return Option.getOrNull(got);
  };

  const fanOut = () =>
    Effect.runPromise(
      fanOutAllUsers([USER]).pipe(
        Effect.provideService(JobQueue, {
          poke: Effect.void,
          send: (batch) => Effect.sync(() => void sent.push(...batch)),
        }),
      ),
    );

  const syncJobs = () => sent.flatMap((m) => (m.job.kind === "sync-account" ? [m.job] : []));

  beforeEach(async () => {
    outbound = blockOutbound();
    sent = [];
    await freshUser(USER);
  });

  it("一个组合一轮,各只装自己那些账户", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "看单" });
    const here = await cex("默认组合里的");
    const there = await cex("看单里的");
    await db(USER).portfolios.assignAccount(there.id, watch.id);

    await fanOut();

    const mine = await roundOf(def.id);
    const other = await roundOf(watch.id);
    expect(Object.keys(mine?.accounts ?? {})).toEqual([here.id]);
    expect(Object.keys(other?.accounts ?? {})).toEqual([there.id]);
    // 发起方记在轮头上 —— 面板要能说出「这一轮是定时跑的」。
    expect(mine?.trigger).toBe("cron");
    expect(other?.trigger).toBe("cron");
  });

  it("一个账户一条 sync-account,指着它所在的那一轮;外加每用户一套参考层活", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "看单" });
    const here = await cex("默认组合里的");
    const there = await cex("看单里的");
    await db(USER).portfolios.assignAccount(there.id, watch.id);

    const result = await fanOut();

    const mine = await roundOf(def.id);
    const other = await roundOf(watch.id);
    expect(syncJobs().sort((a, b) => a.accountId.localeCompare(b.accountId))).toEqual(
      [
        {
          kind: "sync-account",
          userId: USER,
          portfolioId: def.id,
          roundId: mine?.roundId,
          accountId: here.id,
        },
        {
          kind: "sync-account",
          userId: USER,
          portfolioId: watch.id,
          roundId: other?.roundId,
          accountId: there.id,
        },
      ].sort((a, b) => a.accountId.localeCompare(b.accountId)),
    );
    // 每小时那套(FOL-88):一件一条;读快照的两件延后,每天那两件(剪 note / 目录)不在这里。
    const perUser = sent
      .filter((m) => m.job.kind !== "sync-account")
      .map((m) => [m.job.kind, m.delaySeconds !== undefined] as const);
    expect(perUser).toEqual([
      ["prices", false],
      ["daily-prices", false],
      ["fx", false],
      ["platforms", true],
      ["defi-logos", true],
    ]);
    // 价那两件不带 id:跑的那一刻才读持仓(带 id 的是写路径定向投的那种)。
    expect(sent.filter((m) => m.job.kind === "prices" || m.job.kind === "daily-prices")).toEqual([
      { job: { kind: "prices", userId: USER } },
      { job: { kind: "daily-prices", userId: USER } },
    ]);
    expect(result).toEqual({
      users: 1,
      accounts: 2,
      failed: 0,
      jobs: 2 + 5,
      alarms: 2 + 5,
    });
    // 轮开着、还没收官 —— 收官是最后一个 consumer 的事。
    expect(mine?.finishedAt).toBeNull();
  });

  // FOL-86 的全部意义:cron 那一次调用不再碰上游。
  it("fan-out 一发上游都不打", async () => {
    await db(USER).portfolios.ensureDefault();
    await cex("a");
    await cex("b");
    await fanOut();
    expect(syncJobs()).toHaveLength(2);
    expect(outbound.calls).toEqual([]);
  });

  // 用户正好在手动同步:开轮幂等会把那一轮原样还回来,cron 就该让开 —— 不然会有两拨 worker
  // 对着同一批账户打上游。
  it("活轮还在 → cron 不插一脚,不投那一轮的消息", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    await cex("Binance spot");
    const manualRound = await call(USER, openSyncRound({ trigger: "manual" }));
    if (manualRound.round == null) throw new Error("manual open returned no round");

    await fanOut();

    const back = await roundOf(def.id);
    expect(back?.roundId).toBe(manualRound.round.roundId);
    expect(back?.trigger).toBe("manual");
    expect(syncJobs()).toEqual([]);
  });

  // 活轮只装一个账户(加账户 / 详情侧栏点同步开的,FOL-89):cron 不能整组合跳过 —— 其余账户会
  // 缺这一小时的快照。把名单里缺的拉进那一轮、只投它们;活轮里已有的那个不重投。
  it("活轮只装一个账户 → 把其余账户拉进那一轮、只投它们", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const busy = await cex("正在单独同步的");
    const other = await cex("其余的");
    const single = await db(USER).syncRounds.open({
      portfolioId: def.id,
      roundId: "single",
      trigger: "manual",
      accounts: [{ id: busy.id, label: busy.label }],
      ttlMs: 120_000,
    });
    expect(single.opened).toBe(true);

    const result = await fanOut();

    const back = await roundOf(def.id);
    expect(back?.roundId).toBe("single");
    expect(back?.accounts[other.id]?.status).toBe("pending");
    expect(back?.accounts[busy.id]?.status).toBe("pending");
    expect(syncJobs().map((j) => [j.roundId, j.accountId])).toEqual([["single", other.id]]);
    expect(result.accounts).toBe(1);
  });

  // 投递炸了(队列没建 / 配额用完):开了的轮别挂着 pending 干等 120s 再念成没有原因的「中断」,
  // 与手动那条同一个口径 —— 带一句话收官。拉进别人轮的那几个记成 failed。
  it("投递失败 → 自己开的轮带一句话收官,拉进别人轮的账户记 failed;这个用户计 failed", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "看单" });
    const busy = await cex("正在单独同步的");
    const joined = await cex("被拉进去的");
    const there = await cex("看单里的");
    await db(USER).portfolios.assignAccount(there.id, watch.id);
    await db(USER).syncRounds.open({
      portfolioId: def.id,
      roundId: "single",
      trigger: "manual",
      accounts: [{ id: busy.id, label: busy.label }],
      ttlMs: 120_000,
    });

    const result = await Effect.runPromise(
      fanOutAllUsers([USER]).pipe(
        Effect.provideService(JobQueue, {
          poke: Effect.void,
          send: () => Effect.die(new Error("queue down")),
        }),
      ),
    );

    expect(result).toMatchObject({ users: 1, failed: 1, jobs: 0 });
    const mine = await roundOf(watch.id);
    expect(mine?.trigger).toBe("cron");
    expect(mine?.finishedAt).not.toBeNull();
    expect(mine?.error).toBeTruthy();
    const theirs = await roundOf(def.id);
    expect(theirs?.roundId).toBe("single");
    expect(theirs?.accounts[joined.id]?.status).toBe("failed");
    expect(theirs?.accounts[busy.id]?.status).toBe("pending");
    expect(theirs?.finishedAt).toBeNull();
  });

  // 投递之前就炸了(review R2-#4):后面那个组合开轮时 D1 出错,前面已经开了的轮不能挂着 pending
  // 等 120s 再念成没有原因的「中断」—— 与投递失败同一个收尾。用一个只拦那个组合的触发器造这次 D1 失败。
  it("后面的组合开轮时炸了 → 前面已开的轮带一句话收官;这个用户计 failed", async () => {
    await db(USER).portfolios.ensureDefault();
    const watch = await db(USER).portfolios.create({ name: "看单" });
    await cex("默认组合里的");
    const there = await cex("看单里的");
    await db(USER).portfolios.assignAccount(there.id, watch.id);
    const order = (await db(USER).portfolios.list()).map((p) => p.id);
    const [first, last] = [order[0], order[order.length - 1]];
    if (!first || !last || first === last) throw new Error("need two portfolios");
    await env.DB.prepare(
      `CREATE TRIGGER fail_open_last BEFORE INSERT ON user_cache WHEN NEW.k LIKE '%${last}%'
       BEGIN SELECT RAISE(ABORT, 'd1 down'); END`,
    ).run();
    try {
      const result = await fanOut();
      expect(result).toMatchObject({ users: 1, failed: 1, jobs: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_open_last").run();
    }

    expect(sent).toEqual([]);
    const opened = await roundOf(first);
    expect(opened?.trigger).toBe("cron");
    expect(opened?.finishedAt).not.toBeNull();
    expect(opened?.error).toBeTruthy();
    expect(await roundOf(last)).toBeNull();
  });

  // 开了轮就必须收官,空组合也不例外 —— 没有消息会去收它,120s 后面板会挂着一句「中断」。
  it("空组合那一轮当场收官,不投消息", async () => {
    const def = await db(USER).portfolios.ensureDefault();
    await fanOut();
    const back = await roundOf(def.id);
    expect(back?.accounts).toEqual({});
    expect(back?.finishedAt).not.toBeNull();
    expect(syncJobs()).toEqual([]);
  });
});
