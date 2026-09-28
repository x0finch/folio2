import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { JobQueue } from "@/lib/server/jobs/queue";
import {
  handleGetSyncRound,
  openSyncRound,
  ROUND_HEARTBEAT_MS,
  ROUND_RETENTION_MS,
  startSyncRound,
} from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound, type Outbound } from "../_kit/outbound";
import { captureQueue, consumeJob } from "../_kit/queue";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// 开轮 / 读轮(ADR 0048)。对着真 D1 跑,因为这两件事的正确性都在「哪些账户进这一轮」与
// 「同一个键两边算得一样吗」上 —— 那两条都要真的账户行、真的组合归属。

describe("sync/round", () => {
  const USER = "h-sync-round";

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const manual = (label: string) =>
    db(USER).accounts.create({ connectorId: "manual", label, creds: null });

  // 断言侧把 `round` 掀成非空:这套用例造不出「行在两句之间被删」那一幕,真走到就该炸给人看。
  const open = async (portfolioId?: string) => {
    const out = await call(USER, openSyncRound({ portfolioId, trigger: "manual" }));
    if (out.round == null) throw new Error("open returned no round — the row vanished mid-test?");
    return { opened: out.opened, round: out.round };
  };

  const read = (portfolioId: string) => call(USER, handleGetSyncRound({ portfolioId }));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
  });

  describe("开轮", () => {
    it("名单 = 当前组合内、活跃、非手记 —— 与页头摘要同一条判据", async () => {
      const live = await cex("Binance spot");
      const archived = await cex("旧号");
      await db(USER).accounts.setArchived(archived.id, true);
      await manual("手记");

      const { round, opened } = await open();
      expect(opened).toBe(true);
      expect(Object.keys(round.accounts)).toEqual([live.id]);
      expect(round.accounts[live.id]).toEqual({ label: "Binance spot", status: "pending" });
      expect(round.trigger).toBe("manual");
      expect(round.finishedAt).toBeNull();
    });

    it("别的组合里的账户不进这一轮", async () => {
      const here = await cex("默认组合里的");
      const there = await cex("看单里的");
      const watch = await db(USER).portfolios.create({ name: "看单" });
      await db(USER).portfolios.assignAccount(there.id, watch.id);

      const mine = await open();
      expect(Object.keys(mine.round.accounts)).toEqual([here.id]);
      const other = await open(watch.id);
      expect(Object.keys(other.round.accounts)).toEqual([there.id]);
    });

    // 第二个设备点同步 / cron 撞上手动:看到的是同一轮,不是被清空重来的一轮。
    it("活轮还在 → 第二次开轮返回同一轮", async () => {
      await cex("Binance spot");
      const first = await open();
      const second = await open();
      expect(second.opened).toBe(false);
      expect(second.round.roundId).toBe(first.round.roundId);
    });

    it("心跳 = 开轮那一刻 + 120s", async () => {
      await cex("Binance spot");
      const before = Date.now();
      const { round } = await open();
      expect(round.expiresAt).toBeGreaterThanOrEqual(before + ROUND_HEARTBEAT_MS);
      expect(ROUND_RETENTION_MS).toBeGreaterThan(ROUND_HEARTBEAT_MS);
    });
  });

  describe("读轮", () => {
    it("这个组合从没开过 → null(不是一个空轮)", async () => {
      const pf = await db(USER).portfolios.ensureDefault();
      expect(await read(pf.id)).toBeNull();
    });

    it("刚开的一轮 → 在跑,x / N 从 0 起,正在同步的是第一个", async () => {
      await cex("Binance spot");
      await cex("Kraken");
      await open();

      const pf = await db(USER).portfolios.ensureDefault();
      const view = await read(pf.id);
      expect(view?.state).toBe("running");
      expect(view?.total).toBe(2);
      expect(view?.settled).toBe(0);
      expect(view?.synced).toBe(0);
      expect(view?.failed).toEqual([]);
      expect(view?.current).toBe("Binance spot");
    });

    // 开轮对坏 id 退回默认组合(开轮必须落在一个真组合上);读轮**不解析**,直接读键 ——
    // 这是 1.5s 一发的路,省两条查询,而键本身 user-scoped,坏 id 只会读到空键。
    // 客户端传来的永远是选择器里真实存在的 id,所以两边在真实流量上落的是同一个键。
    it("开轮的坏 id 落到默认组合;读轮拿真 id 读得到,拿坏 id 读到空", async () => {
      await cex("Binance spot");
      const opened = await open("pf-never-existed");
      const def = await db(USER).portfolios.ensureDefault();
      expect(opened.round.portfolioId).toBe(def.id);
      expect((await read(def.id))?.roundId).toBe(opened.round.roundId);
      expect(await read("pf-also-nonsense")).toBeNull();
    });
  });

  // `POST /api/sync` 那一轮(FOL-89):**开轮、投消息、即返** —— 这一步一发上游都不打;同步在队列
  // consumer 里跑(出网被掐掉,所以有凭据的那个必定失败)。测的是接线本身:投了哪些消息、结果逐条落进
  // 那一轮、三档分对、最后一个收官。
  describe("手动 / 自动轮(startSyncRound)", () => {
    let outbound: Outbound;
    let queue: ReturnType<typeof captureQueue>;

    const start = async (auto = false, portfolioId?: string) => {
      const out = await call(USER, queue.provide(startSyncRound(USER, { portfolioId, auto })));
      if (out.round == null) throw new Error("start returned no round");
      return { opened: out.opened, round: out.round };
    };

    const consumeAll = async () => {
      for (const job of queue.syncJobs()) {
        expect(await consumeJob(job)).toEqual({ acked: true, retried: false });
      }
    };

    beforeEach(() => {
      outbound = blockOutbound();
      queue = captureQueue();
    });

    it("开轮即投:一个账户一条 sync-account + 每用户一套参考层活,一发上游都不打", async () => {
      const a = await cex("Binance spot");
      const b = await cex("Kraken");

      const { round, opened } = await start();

      expect(opened).toBe(true);
      expect(outbound.calls).toEqual([]);
      expect(
        queue
          .syncJobs()
          .map((j) => j.accountId)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      for (const job of queue.syncJobs()) {
        expect(job).toMatchObject({
          userId: USER,
          portfolioId: round.portfolioId,
          roundId: round.roundId,
        });
      }
      // 以前手动同步的收尾(`warmTokens`)在请求里做的那几件,现在各是一条消息,延后规则与 cron 同一份。
      expect(
        queue.sent
          .filter((m) => m.job.kind !== "sync-account")
          .map((m) => [m.job.kind, m.delaySeconds !== undefined]),
      ).toEqual([
        ["prices", false],
        ["daily-prices", false],
        ["fx", false],
        ["platforms", true],
        ["defi-logos", true],
      ]);
      // 回包是此刻的样子:在跑、一个都还没落账。
      expect(round.finishedAt).toBeNull();
      expect(Object.values(round.accounts).map((x) => x.status)).toEqual(["pending", "pending"]);
    });

    it("消费完那几条消息 → 逐个落账、三档分对、最后一个收官", async () => {
      const willFail = await cex("Binance spot");
      const noKeys = await db(USER).accounts.create({
        connectorId: "binance",
        label: "还没填 key",
        creds: null,
      });

      const { round } = await start();
      await consumeAll();

      const view = await read(round.portfolioId);
      expect(view?.state).toBe("done");
      expect(view?.settled).toBe(2);
      expect(view?.needsKeys).toBe(1);
      expect(view?.failed.map((f) => f.accountId)).toEqual([willFail.id]);
      // 上游的原话原样留着 —— 面板那一行不翻译它。
      expect(view?.failed[0]?.error).toBeTruthy();
      expect(view?.synced).toBe(0);
      expect(view?.statuses).toEqual({ [willFail.id]: "failed", [noKeys.id]: "needs-keys" });
      // 逐账户的失败不是「整轮没跑起来」,那一句必须还是空的。
      expect(view?.error).toBeNull();
    });

    // 第二个设备点同步 / 连点两下:拿回的是同一轮,不投第二拨消息 —— 否则两拨 consumer 对着
    // 同一批账户打上游。
    it("活轮还在 → 原样还回来,不再投消息", async () => {
      await cex("Binance spot");
      const first = await start();
      const sentBefore = queue.sent.length;

      const second = await start();

      expect(second.opened).toBe(false);
      expect(second.round.roundId).toBe(first.round.roundId);
      expect(queue.sent).toHaveLength(sentBefore);
    });

    it("空组合 → 当场收官,一条消息都不投", async () => {
      await manual("手记");
      const { round } = await start();
      expect(round.finishedAt).not.toBeNull();
      expect(queue.sent).toEqual([]);
    });

    // 自动轮按新鲜度跳过(FOL-18 子票 4):有一张 1 小时内快照的账户被当 skipped 收掉、**不投消息**;
    // 没快照的照常投(consumer 里出网被掐 → 失败)。手动轮不跳,强制全量。
    it("自动轮跳过刚同步过的账户;手动轮强制全量", async () => {
      const fresh = await cex("刚同步过");
      const stale = await cex("很久没同步");
      await db(USER).snapshots.write(fresh.id, {
        takenAt: Date.now(),
        totalUsd: 100,
        balances: [],
      });

      const auto = await start(true);
      // 回包已经反映了规划:fresh 那格是 skipped。
      expect(auto.round.accounts[fresh.id]?.status).toBe("skipped");
      expect(queue.syncJobs().map((j) => j.accountId)).toEqual([stale.id]);
      await consumeAll();
      const autoView = await read(auto.round.portfolioId);
      expect(autoView?.state).toBe("done");
      expect(autoView?.skipped).toBe(1);
      expect(autoView?.failed.map((f) => f.accountId)).toEqual([stale.id]);

      queue = captureQueue();
      const manualRound = await start(); // 上一轮已收官,开得动
      expect(manualRound.opened).toBe(true);
      expect(
        queue
          .syncJobs()
          .map((j) => j.accountId)
          .sort(),
      ).toEqual([fresh.id, stale.id].sort());
      expect(outbound.calls).toEqual([]);
    });

    // 未来时间戳(时钟偏移)按「新鲜」处理;全都新鲜 → 没有消息要投 → 当场收官,参考层那几条也不投。
    it("自动轮里全都新鲜 → 当场收官,一条消息都不投", async () => {
      const future = await cex("时钟偏移到未来");
      await db(USER).snapshots.write(future.id, {
        takenAt: Date.now() + 60 * 60 * 1000,
        totalUsd: 100,
        balances: [],
      });

      const { round } = await start(true);

      expect(round.finishedAt).not.toBeNull();
      expect(round.accounts[future.id]?.status).toBe("skipped");
      expect(queue.sent).toEqual([]);
    });

    // 上一轮投出去、还没消费的消息,在新一轮开了之后才落到 consumer:它那几笔写落空,新一轮不被改花。
    it("上一轮的消息写不进新一轮", async () => {
      await cex("Binance spot");
      const stale = await start();
      const staleJobs = queue.syncJobs();
      await db(USER).syncRounds.finish({
        portfolioId: stale.round.portfolioId,
        roundId: stale.round.roundId,
        retentionMs: 1_000,
      });
      const fresh = await start();
      expect(fresh.opened).toBe(true);

      for (const job of staleJobs) await consumeJob(job);

      const view = await read(fresh.round.portfolioId);
      expect(view?.roundId).toBe(fresh.round.roundId);
      expect(view?.settled).toBe(0);
      expect(view?.state).toBe("running");
    });

    // 投递炸了:别让面板对着一轮永远不会有人跑的「在跑」干等 120s —— 带一句话收官,再让请求失败。
    it("投递失败 → 这一轮带着一句话收官,请求失败", async () => {
      await cex("Binance spot");
      const exit = await call(
        USER,
        Effect.exit(
          startSyncRound(USER, { auto: false }).pipe(
            Effect.provideService(JobQueue, { send: () => Effect.die(new Error("queue down")) }),
          ),
        ),
      );
      expect(exit._tag).toBe("Failure");
      const pf = await db(USER).portfolios.ensureDefault();
      const round = Option.getOrNull(await db(USER).syncRounds.get(pf.id));
      expect(round?.finishedAt).not.toBeNull();
      expect(round?.error).toBeTruthy();
    });
  });
});
