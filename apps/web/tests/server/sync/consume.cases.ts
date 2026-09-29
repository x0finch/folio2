import { Oracle } from "@folio/oracle";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_MAX_RETRIES } from "@/lib/server/jobs/constants";
import { consumeMessage, type QueueMessage } from "@/lib/server/jobs/consume";
import type { SyncAccountJob } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { fanOutAllUsers, ROUND_HEARTBEAT_MS } from "@/lib/server/sync/round";
import { db } from "../_kit/db";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
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
    // FOL-87:估值只读价表,**一发 CoinGecko 都不打**(价归队列的 `prices` 活)。
    expect(outbound.calls.filter((u) => u.includes("coingecko"))).toEqual([]);
  });

  // FOL-87:重估用价表里的价(哪怕是 stale 的),不回源。
  it("估值用价表里已有的价,零 CoinGecko 请求", async () => {
    await db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    // 先让价表里有 BTC 的价:mint 出那一行,再经真的刷价路径写进去。
    const ids = await call(
      USER,
      Effect.flatMap(Oracle, (o) =>
        o.tokens.mint([{ ref: "bitcoin/native", seed: { symbol: "BTC" } }]),
      ),
    );
    const btc = ids.get("bitcoin/native");
    if (!btc) throw new Error("BTC not minted");
    stubOutbound([
      ["/simple/price", () => json({ bitcoin: { usd: 40_000, last_updated_at: 1_700_000_000 } })],
      ["/coins/markets", () => json([])],
    ]);
    await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.refreshStale([btc])),
    );
    const priced = await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.pricesOf([btc])),
    );
    expect(priced.get(btc)?.unitPrice).toBe(40_000);

    const outbound = stubOutbound([
      [
        "/api/v2/address/",
        () => json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" }),
      ],
    ]);
    expect(await consume(job)).toEqual({ acked: true, retried: false });

    expect(outbound.calls.filter((u) => u.includes("coingecko"))).toEqual([]);
    const [latest] = await db(USER).snapshots.latest();
    expect(latest?.snapshot.totalUsd).toBe(60_000); // 1.5 BTC × 表里的 40k
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

    // 不收尾的话那个账户永远 pending,面板要等心跳过期才说「中断」。收完尾照样 retry()
    // (次数已用完,运行器据此把它埋掉,见 tests/job-runner.test.ts)—— FOL-86 验收:失败的活看得见。
    it("最后一次投递仍失败 → 记 failed、收官,再 retry() 交给运行器埋掉(不 ack)", async () => {
      await cex("a");
      const [job] = await fanOut();
      if (!job) throw new Error("no job enqueued");
      const { message, state } = fakeMessage(job, JOB_MAX_RETRIES + 1);
      await Effect.runPromise(consumeMessage(message, boom));
      expect(state).toEqual({ acked: false, retried: true });
      const round = await roundOf(job.portfolioId);
      expect(round?.accounts[job.accountId]?.status).toBe("failed");
      expect(round?.accounts[job.accountId]?.error).toContain("D1 hiccup");
      expect(round?.finishedAt).not.toBeNull();
    });

    // 刷价这类活没有收尾可做,但最终失败一样要被埋下、看得见,不能 ack 掉只剩一行日志。
    it("没有收尾的活最后一次失败 → 同样 retry()(交给运行器埋掉)", async () => {
      const { message, state } = fakeMessage({ kind: "prices", userId: USER }, JOB_MAX_RETRIES + 1);
      await Effect.runPromise(consumeMessage(message, boom));
      expect(state).toEqual({ acked: false, retried: true });
    });

    // 埋掉的那条要是被人挖出来重跑:收尾已把账户记成 failed,「还 pending 吗」挡下它,不再出网。
    it("埋掉的 sync-account 再被投一次 → 空跑,不出网、不改写", async () => {
      await cex("a");
      const [job] = await fanOut();
      if (!job) throw new Error("no job enqueued");
      await Effect.runPromise(consumeMessage(fakeMessage(job, JOB_MAX_RETRIES + 1).message, boom));
      const outbound = blockOutbound();
      expect(await consume(job)).toEqual({ acked: true, retried: false });
      expect(outbound.calls).toEqual([]);
      expect((await roundOf(job.portfolioId))?.accounts[job.accountId]?.error).toContain(
        "D1 hiccup",
      );
    });
  });

  // —— 两条投递同时在跑(at-least-once 重投、enlist 已 pending 的账户)——
  //
  // 上游那一发挂起,直到两条都进了同步(= 都越过了「还 pending 吗」),再一起放行。
  const gatedBlockbook = (inFlightTarget: number) => {
    let inFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 兜底:另一条没进来(被「还 pending 吗」挡下)时别把用例挂死 —— 放行后由断言报出来。
    const timer = setTimeout(() => release(), 5_000);
    const reached = { max: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("/api/v2/address/")) throw new Error(`没有为这个 URL 准备答案:${url}`);
      inFlight++;
      reached.max = Math.max(reached.max, inFlight);
      if (inFlight >= inFlightTarget) release();
      await gate;
      clearTimeout(timer);
      return json({ address: BTC_ADDRESS, balance: "150000000", unconfirmedBalance: "0" });
    });
    return { reached, release };
  };

  const bitcoin = () =>
    db(USER).accounts.create({
      connectorId: "bitcoin",
      label: "cold",
      creds: JSON.stringify({ addressOrXpub: BTC_ADDRESS }),
    });

  // #571 review:后到的那条 settle 以前照样匹配 —— 把收官写下的 7 天保留期改回 120 秒,
  // 状态也听后到的。现在只有 pending → 终态那一步,且收官的轮一个字都不改。
  it("同一个账户两条投递并发 → 两条都跑,但只落一次账;收官的保留期不被改短", async () => {
    await bitcoin();
    const [job] = await fanOut();
    if (!job) throw new Error("no job enqueued");
    const gate = gatedBlockbook(2);

    const [a, b] = await Promise.all([consume(job), consume(job)]);

    expect(gate.reached.max).toBe(2); // 两条都越过了「还 pending 吗」
    expect(a).toEqual({ acked: true, retried: false });
    expect(b).toEqual({ acked: true, retried: false });
    const round = await roundOf(job.portfolioId);
    expect(round?.accounts[job.accountId]?.status).toBe("synced");
    expect(round?.finishedAt).not.toBeNull();
    expect(round?.expiresAt).toBeGreaterThan(Date.now() + ROUND_HEARTBEAT_MS);
  });

  // #571 review:重投之间没有落账,心跳只靠 consumer 开跑前那一下续。上游挂起时读一眼:已续到
  // now + ROUND_HEARTBEAT_MS,而不是还停在开轮那一刻。
  it("每次投递开跑前续心跳 —— 重投链上的轮不会先被念成「中断」", async () => {
    await bitcoin();
    await cex("另一个"); // 让这一条落账后轮还不收官
    const jobs = await fanOut();
    const btcJob = (
      await Promise.all(
        jobs.map(async (j) => ({ j, a: await db(USER).accounts.getById(j.accountId) })),
      )
    ).find((x) => x.a?.connectorId === "bitcoin")?.j;
    if (!btcJob) throw new Error("no bitcoin job");
    // 模拟「上一次投递以 defect 收场、隔了一个重投间隔」:心跳只剩 1 秒。
    await db(USER).syncRounds.touch({
      portfolioId: btcJob.portfolioId,
      roundId: btcJob.roundId,
      ttlMs: 1_000,
    });
    const gate = gatedBlockbook(1);
    const running = consume(btcJob);
    // 等上游那一发真挂起(= 已越过开跑前那一步)再读。
    while (gate.reached.max < 1) await new Promise((r) => setTimeout(r, 5));
    const seen = (await roundOf(btcJob.portfolioId))?.expiresAt;
    gate.release();
    await running;

    expect(seen).toBeGreaterThan(Date.now() + ROUND_HEARTBEAT_MS - 10_000);
  });
});
