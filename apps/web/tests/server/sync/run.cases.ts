import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runForUser } from "@/lib/server/runtime";
import { startSyncRound } from "@/lib/server/sync/round";
import { handleSyncAccount, SyncAccountInput, type SyncAccountStart } from "@/lib/server/sync/run";
import { db } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { captureQueue, consumeJob } from "../_kit/queue";
import { seedManualAccount } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// 合并进 sync/index.test.ts 跑(#527 后续件 2):每个 vitest 文件要在 workerd 里
// 重新评估整张 import 图(实测 ~9s/文件),按目录合并把这笔钱只付一次。
describe("sync/run", () => {
  // #527 · syncAccount
  //
  // **这是全仓唯一显式收 userId 的 handler**(投的消息要带它),所以它不走 `runEffect`,
  // 也不能用 kit 里的 `call` —— 那个把 userId 吃在装配点。这里直接用同一个内核 `runForUser`,
  // 与 `sync/index.ts` 的装配逐字一致;投递换成收进数组的假队列(`captureQueue`)。
  const USER = "h-sync-run";
  let queue: ReturnType<typeof captureQueue>;

  const run = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
    // biome-ignore lint/suspicious/noExplicitAny: 与生产装配点同形,handler 的 R 由内核补齐
    runForUser(userId, queue.provide(effect) as any) as Promise<A>;

  const exitOf = <A, E, R>(userId: string, effect: Effect.Effect<A, E, R>) =>
    run(userId, Effect.exit(effect));

  beforeEach(async () => {
    blockOutbound();
    queue = captureQueue();
    await freshUser(USER);
    await freshUser(otherUser(USER));
  });

  describe("syncAccount", () => {
    it("手记账户 → 跳过,理由是「没有上游」,一发外呼都不发", async () => {
      const outbound = blockOutbound();
      const acc = await seedManualAccount(USER, "手记", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });

      const out = await run(USER, handleSyncAccount(USER, { accountId: acc.id }));

      expect(out).toEqual({
        queued: false,
        result: { accountId: acc.id, ok: false, skipped: true, skipReason: "manual" },
      });
      expect(outbound.calls).toEqual([]);
      expect(queue.sent).toEqual([]);
    });

    it("账户不存在 → NotFound,不发请求", async () => {
      const outbound = blockOutbound();

      const exit = await exitOf(USER, handleSyncAccount(USER, { accountId: "没有这个" }));

      expect(exit._tag).toBe("Failure");
      expect(outbound.calls).toEqual([]);
    });

    it("账户是别人的 → NotFound,不发请求", async () => {
      const outbound = blockOutbound();
      const theirs = await seedManualAccount(otherUser(USER), "他们的", {
        symbol: "BTC",
        unitPrice: 1,
        amount: 1,
      });

      const exit = await exitOf(USER, handleSyncAccount(USER, { accountId: theirs.id }));

      expect(exit._tag).toBe("Failure");
      expect(outbound.calls).toEqual([]);
    });

    it("凭据不齐的 CEX 账户 → 跳过,但理由是「凭据没填完」,与手记账户分得开", async () => {
      // #527 裁定 2:两者都跳过,但只有这一种有下一步动作(去把凭据填完)。以前返回的形状
      // 一模一样,界面上都只能显示成「跳过了」—— 点了同步什么都不发生,而唯一该做的事没说。
      const acc = await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "只有一半" }),
      });

      const out = await run(USER, handleSyncAccount(USER, { accountId: acc.id }));

      expect(out).toEqual({
        queued: false,
        result: {
          accountId: acc.id,
          ok: false,
          skipped: true,
          skipReason: "missing-credentials",
        },
      });
    });

    it("凭据不齐 → 一发上游都不打、一条消息都不投(#527 发现 3)", async () => {
      // 原来 skipped 之后照样跑 warmTokens,白烧 4 发(exchange_rates ×2 + coins/markets ×2)。
      // FOL-89 起连排队都不排:这句话当场答得出,不值一条消息、一次调用。
      const outbound = blockOutbound();
      const acc = await db(USER).accounts.create({
        connectorId: "binance",
        label: "币安",
        creds: JSON.stringify({ apiKey: "只有一半" }),
      });

      await run(USER, handleSyncAccount(USER, { accountId: acc.id }));

      expect(outbound.calls).toEqual([]);
      expect(queue.sent).toEqual([]);
    });

    // —— FOL-89:排进一轮、投一条消息、即返 ——

    const cex = (label: string) =>
      db(USER).accounts.create({
        connectorId: "binance",
        label,
        creds: JSON.stringify({ apiKey: "k", secret: "s" }),
      });

    const queued = async (accountId: string) => {
      const out: SyncAccountStart = await run(USER, handleSyncAccount(USER, { accountId }));
      if (!out.queued) throw new Error(`expected a queued sync, got ${JSON.stringify(out)}`);
      return out;
    };

    it("凭据齐的账户 → 开一轮只装它一个的轮、投一条 sync-account + 参考层那几条;一发上游都不打", async () => {
      const outbound = blockOutbound();
      await cex("别的账户");
      const acc = await cex("币安");

      const out = await queued(acc.id);

      expect(outbound.calls).toEqual([]);
      const def = await db(USER).portfolios.ensureDefault();
      expect(out.portfolioId).toBe(def.id);
      expect(out.round.state).toBe("running");
      expect(out.round.statuses).toEqual({ [acc.id]: "pending" });
      expect(queue.syncJobs()).toEqual([
        {
          kind: "sync-account",
          userId: USER,
          portfolioId: def.id,
          roundId: out.roundId,
          accountId: acc.id,
        },
      ]);
      expect(queue.sent.map((m) => m.job.kind)).toEqual([
        "sync-account",
        "prices",
        "daily-prices",
        "fx",
        "platforms",
        "defi-logos",
      ]);
    });

    it("消费那条消息 → 这个账户落账、那一轮收官(前端等的就是这一格)", async () => {
      const acc = await cex("币安");
      const out = await queued(acc.id);

      const [job] = queue.syncJobs();
      expect(await consumeJob(job)).toEqual({ acked: true, retried: false });

      const round = Option.getOrNull(await db(USER).syncRounds.get(out.portfolioId));
      expect(round?.roundId).toBe(out.roundId);
      expect(round?.accounts[acc.id]?.status).toBe("failed"); // 出网被掐
      expect(round?.finishedAt).not.toBeNull();
    });

    it("账户在别的组合里 → 排进那个组合的轮", async () => {
      const watch = await db(USER).portfolios.create({ name: "看单" });
      const acc = await cex("看单里的");
      await db(USER).portfolios.assignAccount(acc.id, watch.id);

      const out = await queued(acc.id);

      expect(out.portfolioId).toBe(watch.id);
      expect(queue.syncJobs()[0]?.portfolioId).toBe(watch.id);
    });

    // 同组合正有一轮在跑(另一个设备点了全量、cron 刚开轮):不覆盖它,把这个账户拉进去。
    it("撞上活轮 → 拉进那一轮(名单外的加进来),不另开一轮", async () => {
      await cex("已在轮里的");
      const full = await run(USER, startSyncRound(USER, { auto: false }));
      if (!full.round) throw new Error("no round");
      const late = await cex("轮开了之后才加的");
      queue = captureQueue();

      const out = await queued(late.id);

      expect(out.roundId).toBe(full.round.roundId);
      expect(Object.keys(out.round.statuses)).toHaveLength(2);
      expect(out.round.statuses[late.id]).toBe("pending");
      expect(queue.syncJobs().map((j) => [j.roundId, j.accountId])).toEqual([
        [full.round.roundId, late.id],
      ]);
    });

    // 幂等:连点两下(或手动撞上 cron 那一条)→ 同一个账户两条消息,但只同步一遍。
    it("同一个账户投了两条 → 先到的那条同步落账,后到的空跑(不出网、不重写)", async () => {
      const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
      const acc = await db(USER).accounts.create({
        connectorId: "bitcoin",
        label: "cold",
        creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
      });
      const first = await queued(acc.id);
      const second = await queued(acc.id);
      expect(second.roundId).toBe(first.roundId);
      const [a, b] = queue.syncJobs();
      expect(b).toEqual(a);

      const outbound = stubOutbound([
        [
          "/api/v2/address/",
          () => json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" }),
        ],
      ]);
      await consumeJob(a);
      const afterFirst = outbound.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      await consumeJob(b);
      expect(outbound.calls.length).toBe(afterFirst);

      const round = Option.getOrNull(await db(USER).syncRounds.get(first.portfolioId));
      expect(round?.accounts[acc.id]?.status).toBe("synced");
      const latest = await db(USER).snapshots.latest();
      expect(latest.map((s) => s.snapshot.accountId)).toEqual([acc.id]);
    });

    it("accountId 空串 → schema 拒", () => {
      expect(SyncAccountInput.safeParse({ accountId: "" }).success).toBe(false);
    });

    // —— 这几条的家在 sync 内核(`packages/sync/tests/orchestrator.test.ts`)——
    //
    // 那边本来就有假 provider 的接缝(`FetchOutcome` 注入),不需要伪造任何交易所报文:
    //   · **真清仓 → 写空快照**:「上游返回空余额列表 → 照样写一张空快照」(#527 后续件 6 补上)
    //   · **失败 → 保旧快照**:「重试用尽 → ok:false,不写快照」(一直就有)
    //   · **401 → 不重试、类型化失败**:「不可重试错误(AUTH_FAILED)不重试」(一直就有)
    //
    // 剩下真没人测的一条留在这儿(「同一账户两个同步同时进来」FOL-89 起由上面那条「投了两条」钉着):
    it.skip("上游返回一个从没见过的币 → 该建的映射建上,不整趟失败", () => {});
  });
});
