import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { JOB_MAX_RETRIES } from "@/lib/server/jobs/constants";
import { consumeMessage, type QueueMessage } from "@/lib/server/jobs/consume";
import type { SyncAccountJob } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutAllUsers } from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { freshUser } from "../_kit/user";

// 队列 consumer(FOL-86):一条 `sync-account` = 同步恰好那一个账户、落账、最后一个收官。
// 消息从真的 fan-out 里来(不手拼),于是「cron 投的」与「consumer 认的」是同一个形状。

/** 免费计划一次调用的外部 subrequest 上限。一条消息 = 一次调用,所以它就是一条消息的出网预算。 */
const FREE_PLAN_SUBREQUESTS = 50;

// 一个格式合法的 BTC 地址(过得了 connector 的校验闸)。余额是桩出来的,地址是谁的无所谓。
const BTC_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

describe("jobs/consume", () => {
  const USER = "h-jobs-consume";

  const fakeMessage = (body: unknown, attempts = 1) => {
    const state = { acked: false, retried: false };
    const message: QueueMessage = {
      id: `m-${Math.random()}`,
      body,
      attempts,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
    };
    return { message, state };
  };

  const consume = (body: unknown, attempts = 1) => {
    const { message, state } = fakeMessage(body, attempts);
    return Effect.runPromise(consumeMessage(message)).then(() => state);
  };

  const fanOut = async (): Promise<SyncAccountJob[]> => {
    const sent: Enqueued[] = [];
    await Effect.runPromise(
      fanOutAllUsers([USER]).pipe(
        Effect.provideService(JobQueue, {
          send: (batch) => Effect.sync(() => void sent.push(...batch)),
        }),
      ),
    );
    return sent.flatMap((m) => (m.job.kind === "sync-account" ? [m.job] : []));
  };

  const cex = (label: string) =>
    db(USER).accounts.create({
      connectorId: "binance",
      label,
      creds: JSON.stringify({ apiKey: "k", secret: "s" }),
    });

  const roundOf = async (portfolioId: string) =>
    Option.getOrNull(await db(USER).syncRounds.get(portfolioId));

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  it("逐条落账,最后一条收官;每条都 ack", async () => {
    await cex("a");
    await cex("b");
    const jobs = await fanOut();
    expect(jobs).toHaveLength(2);
    const [first, second] = jobs as [SyncAccountJob, SyncAccountJob];

    expect(await consume(first)).toEqual({ acked: true, retried: false });
    const mid = await roundOf(first.portfolioId);
    // 出网被掐 → 这个账户失败,但它是「落了账的失败」,不是队列重试。
    expect(mid?.accounts[first.accountId]?.status).toBe("failed");
    expect(mid?.accounts[second.accountId]?.status).toBe("pending");
    expect(mid?.finishedAt).toBeNull();

    expect(await consume(second)).toEqual({ acked: true, retried: false });
    const done = await roundOf(first.portfolioId);
    expect(done?.accounts[second.accountId]?.status).toBe("failed");
    expect(done?.finishedAt).not.toBeNull();
  });

  it("成功那一条:写快照、记 synced —— 且一条消息的出网不超过免费计划的 50 发", async () => {
    const acc = await db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    // 只有 Blockbook 那一条有答案;其余(估值要的价)照旧抛错 —— 抛错的也算进账,
    // 因为它们同样花掉一个 subrequest。
    const outbound = stubOutbound([
      [
        "/api/v2/address/",
        () => json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" }),
      ],
    ]);

    expect(await consume(job)).toEqual({ acked: true, retried: false });

    const round = await roundOf(job.portfolioId);
    expect(round?.accounts[acc.id]?.status).toBe("synced");
    expect(round?.finishedAt).not.toBeNull();
    const latest = await db(USER).snapshots.latest();
    expect(latest.map((s) => s.snapshot.accountId)).toEqual([acc.id]);
    expect(outbound.calls.length).toBeGreaterThan(0);
    expect(outbound.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  // 最坏情形:上游整个够不到,内核的重试全用满。仍是一次调用的预算。
  // Blockbook 是最能放大的那家:四个公共节点轮换 × 内核的重试。
  it("上游全挂(重试用满)时一条消息的出网也不超过 50 发", async () => {
    await db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });
    const [job] = await fanOut();
    const outbound = blockOutbound();
    await consume(job);
    expect(outbound.calls.length).toBeGreaterThan(0);
    expect(outbound.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  });

  // at-least-once:同一条投两遍,第二遍不该再打一次上游。
  it("重复投递 / 轮已被覆盖 → 跳过,不出网,照样 ack", async () => {
    await cex("a");
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    await consume(job);
    const outbound = blockOutbound();
    expect(await consume(job)).toEqual({ acked: true, retried: false });
    expect(await consume({ ...job, roundId: "some-older-round" })).toEqual({
      acked: true,
      retried: false,
    });
    expect(outbound.calls).toEqual([]);
  });

  it("账户在排队期间被删 → 记 skipped,轮照样收官", async () => {
    const acc = await cex("a");
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    await db(USER).accounts.remove(acc.id);
    await consume(job);
    const round = await roundOf(job.portfolioId);
    expect(round?.accounts[acc.id]?.status).toBe("skipped");
    expect(round?.finishedAt).not.toBeNull();
  });

  it("解不开的消息 → ack 丢弃,不重试", async () => {
    expect(await consume({ kind: "nope" })).toEqual({ acked: true, retried: false });
    expect(await consume("not even an object")).toEqual({ acked: true, retried: false });
    expect(await consume({ kind: "sync-account", userId: USER })).toEqual({
      acked: true,
      retried: false,
    });
  });

  describe("失败的活", () => {
    const boom = () => Effect.fail(new Error("D1 hiccup"));

    it("还有重投机会 → retry,轮里那个账户仍 pending", async () => {
      await cex("a");
      const [job] = await fanOut();
      if (!job) throw new Error("no job enqueued");
      const { message, state } = fakeMessage(job, 1);
      await Effect.runPromise(consumeMessage(message, boom));
      expect(state).toEqual({ acked: false, retried: true });
      expect((await roundOf(job.portfolioId))?.accounts[job.accountId]?.status).toBe("pending");
    });

    // 不收尾的话那个账户永远 pending,面板要等心跳过期才说「中断」。
    it("最后一次投递仍失败 → 记 failed、收官、ack(不进死信)", async () => {
      await cex("a");
      const [job] = await fanOut();
      if (!job) throw new Error("no job enqueued");
      const { message, state } = fakeMessage(job, JOB_MAX_RETRIES + 1);
      await Effect.runPromise(consumeMessage(message, boom));
      expect(state).toEqual({ acked: true, retried: false });
      const round = await roundOf(job.portfolioId);
      expect(round?.accounts[job.accountId]?.status).toBe("failed");
      expect(round?.accounts[job.accountId]?.error).toContain("D1 hiccup");
      expect(round?.finishedAt).not.toBeNull();
    });
  });
});
