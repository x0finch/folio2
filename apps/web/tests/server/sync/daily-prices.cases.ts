import { FIAT_NAMER, MS_PER_DAY, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { Effect, Either } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCreateAccountAndRefill } from "@/lib/server/accounts/create";
import { handleGetAccountHistory } from "@/lib/server/accounts/history";
import {
  DAILY_PRICES_CALLS_PER_MESSAGE,
  DAILY_PRICES_UPSTREAM_CALLS,
} from "@/lib/server/jobs/constants";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import { decodeJob, type Job } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { loadManualAccountSeries } from "@/lib/server/manual/store";
import { handleCreateManualActivitiesAndRefill } from "@/lib/server/manual-activities/create";
import { handleUpdateManualActivityAndRefill } from "@/lib/server/manual-activities/update";
import { handleGetPortfolioHistory } from "@/lib/server/portfolio/get-history";
import { handleGetSnapshots } from "@/lib/server/portfolio/snapshots";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound, json } from "../_kit/outbound";
import { captureQueue } from "../_kit/queue";
import { call, callWithRegistry } from "../_kit/run";
import { freshUser } from "../_kit/user";
import { oracleDbFor } from "../db-effect";
import { ticketOf } from "../ticket";

// 队列的 `daily-prices` 活(FOL-90):手记历史曲线的日价回源处,一条消息 ≤ 预算;读图表的三个
// 端点只读表。出网数按**真 fetch** 数(CoinGecko adapter 真在发区间请求),不是数假上游的方法调用。

/** 免费计划一次调用的外部 subrequest 上限。一条消息 = 一次调用。 */
const FREE_PLAN_SUBREQUESTS = 50;
const YEARS_3 = 3 * 365;

describe("jobs/daily-prices", () => {
  const USER = "h-jobs-daily-prices";

  /** 跑一条消息,顺手收下它投出去的后续消息。 */
  const consume = async (body: Job) => {
    const sent: Enqueued[] = [];
    const state = { acked: false, retried: false };
    const message: JobMessage = {
      id: `m-${Math.random()}`,
      body,
      attempts: 1,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
    };
    await Effect.runPromise(
      consumeMessage(message).pipe(
        Effect.provideService(JobQueue, {
          poke: Effect.void,
          send: (batch) => Effect.sync(() => void sent.push(...batch)),
        }),
      ),
    );
    return { state, sent };
  };

  // `/coins/{id}/market_chart/range`:区间里每个 UTC 日起点一个点(币价 = 100,BTC 的欧元价 = 80)。
  // `failFirst`:同一个 URL 的前 k 次答 503(可重试),之后才给 —— 见最坏情形那条(code review #21)。
  const rangeUpstream = (
    opts: { fail?: boolean; failFirst?: number } = {},
  ): { calls: string[] } => {
    const calls: string[] = [];
    const seen = new Map<string, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const u = new URL(url);
      if (!u.pathname.endsWith("/market_chart/range")) {
        throw new Error(`没有为这个 URL 准备答案:${url}`);
      }
      const tries = (seen.get(url) ?? 0) + 1;
      seen.set(url, tries);
      if (opts.fail || tries <= (opts.failFirst ?? 0)) return json({ error: "down" }, 503);
      const fromMs = Number(u.searchParams.get("from")) * 1000;
      const toMs = Number(u.searchParams.get("to")) * 1000;
      const price = u.searchParams.get("vs_currency") === "eur" ? 80 : 100;
      const prices: [number, number][] = [];
      for (let t = Math.ceil(fromMs / MS_PER_DAY) * MS_PER_DAY; t <= toMs; t += MS_PER_DAY) {
        prices.push([t, price]);
      }
      return json({ prices });
    });
    return { calls };
  };

  const rangeCalls = (calls: readonly string[]) =>
    calls.filter((u) => new URL(u).pathname.endsWith("/market_chart/range")).length;

  const eurCash = {
    symbol: "EUR",
    unitPrice: 1.1,
    ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "EUR")),
  };

  /**
   * 一个手记账户,三个认得出来的币 + 欧元现金,首笔活动都在 `daysAgo` 天前。
   * `coins` / `cash` 可换:日价表是全局的、不随用户清(别的用例、别的测试文件会补同名币),
   * 要量「真回源多少发」的用例得用只有它自己用的币。
   */
  const manualAccount = async (
    daysAgo: number,
    { coins = ["bitcoin", "ethereum", "solana"], cash = true } = {},
  ) => {
    const account = await db(USER).accounts.create({
      connectorId: "manual",
      label: "M",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    const at = Date.now() - daysAgo * MS_PER_DAY;
    const queue = captureQueue();
    await call(
      USER,
      queue.provide(
        handleCreateManualActivitiesAndRefill({
          accountId: account.id,
          drafts: [
            ...coins.map((coin) => ({
              token: {
                symbol: coin.slice(0, 3).toUpperCase(),
                unitPrice: 1,
                ticket: ticketOf(coin),
              },
              kind: "add" as const,
              amount: 1,
              occurredAt: at,
              price: 1,
            })),
            ...(cash
              ? [{ token: eurCash, kind: "set" as const, amount: 100, occurredAt: at, price: 1.1 }]
              : []),
          ],
        }),
      ),
    );
    return { account, queue };
  };

  /** 把一条消息与它投出的后续消息一路跑完,回每条消息的真 fetch 数。 */
  const drain = async (first: Job) => {
    const perMessage: number[] = [];
    const queue: Job[] = [first];
    while (queue.length > 0) {
      const job = queue.shift() as Job;
      const outbound = rangeUpstream();
      const { state, sent } = await consume(job);
      expect(state).toEqual({ acked: true, retried: false });
      perMessage.push(outbound.calls.length);
      for (const m of sent) {
        expect(Either.isRight(decodeJob(m.job))).toBe(true);
        queue.push(m.job);
      }
      expect(perMessage.length).toBeLessThan(20); // 接力链必须收敛
    }
    return perMessage;
  };

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  it("每小时 cron 那一套里有一条不带 id、不延后的 `daily-prices`", async () => {
    const { hourlyUserJobs } = await import("@/lib/server/jobs/schedule");
    expect(hourlyUserJobs(USER)).toContainEqual({ job: { kind: "daily-prices", userId: USER } });
  });

  it("没有手记账户 → 零出网、不往下投", async () => {
    const outbound = rangeUpstream();
    const { state, sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(outbound.calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("三年回填 → 多条消息接力,每条 ≤ 预算;补完之后重跑零出网", async () => {
    const { account } = await manualAccount(YEARS_3);

    const perMessage = await drain({ kind: "daily-prices", userId: USER });

    // 3 个币 × 3 窗 + 欧元 3 窗 × 2(按两条腿记账)= 15 发的量 > 一条消息的 8 → 至少两条。
    expect(perMessage.length).toBeGreaterThanOrEqual(2);
    for (const n of perMessage) {
      expect(n).toBeLessThanOrEqual(DAILY_PRICES_UPSTREAM_CALLS);
      expect(n).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    }
    expect(perMessage[0]).toBeLessThanOrEqual(DAILY_PRICES_CALLS_PER_MESSAGE);

    // 表里从首笔活动那天到昨天逐日都有价(币)/ 汇率(欧元 = BTC美元 ÷ BTC欧元 = 100 / 80)。
    const holdings = await db(USER).manual.listHoldings(account.id, "coingecko");
    const todayB = Math.floor(Date.now() / MS_PER_DAY);
    const past = Array.from({ length: YEARS_3 }, (_, i) => todayB - YEARS_3 + i);
    for (const h of holdings.filter((x) => x.ref)) {
      expect((await oracleDbFor(USER).tokenPrices.getDaily(h.id, past)).size).toBe(YEARS_3);
    }
    const eur = await oracleDbFor(USER).tokenPrices.getDailyByRef(
      tokenRef.issued(FIAT_NAMER, "EUR"),
      past,
    );
    expect(eur.size).toBe(YEARS_3);
    expect(eur.get(todayB - 1)).toBeCloseTo(1.25);

    // 重跑:一次缓存读,一发都不出。
    const again = rangeUpstream();
    const { sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(rangeCalls(again.calls)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("上游挂了 → 这一条 ack、不往下投(不原地打转),下一个整点再试", async () => {
    await manualAccount(10);
    rangeUpstream({ fail: true });
    const { state, sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(sent).toEqual([]);
  });

  // 其余用例的上游一次就成,「每发 × 尝试次数」那一半推导从没被走到。这条先用一直挂的上游量出
  // adapter 实际肯试几次(同一个 URL 被打了几遍 = N),再让每个 URL 前 (N − 1) 次失败:
  // 一条消息把 `DAILY_PRICES_CALLS_PER_MESSAGE` 窗全花掉、每窗都试满 N 次,仍须 ≤ 50。
  it("最坏情形(每一窗都把重试用满)→ 一条消息仍 ≤ 50 发", async () => {
    // 只有这条用的四个币(日价表全局共享,表里有整窗就不出网 —— 用常见币会量到别人补过的)。
    // 4 币 × 3 窗 = 12 窗 > 一条消息的 8 窗 → 预算必然花满。
    await manualAccount(YEARS_3, { coins: ["wa1x", "wb2x", "wc3x", "wd4x"], cash: false });

    const down = rangeUpstream({ fail: true });
    await consume({ kind: "daily-prices", userId: USER });
    const [firstUrl] = down.calls;
    const attempts = down.calls.filter((u) => u === firstUrl).length;
    expect(attempts).toBeGreaterThan(1); // 真在重试

    const flaky = rangeUpstream({ failFirst: attempts - 1 });
    const { state, sent } = await consume({ kind: "daily-prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(sent.length).toBeGreaterThan(0); // 三年的量一条装不下 → 预算确实花满了
    expect(rangeCalls(flaky.calls)).toBe(DAILY_PRICES_CALLS_PER_MESSAGE * attempts);
    expect(flaky.calls.length).toBeLessThanOrEqual(DAILY_PRICES_UPSTREAM_CALLS);
    expect(flaky.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
  }, 60_000);

  it("读图表的三个端点对手记账户**一发都不出网**(补没补齐都一样)", async () => {
    const { account } = await manualAccount(YEARS_3);
    const reads = async () => {
      const outbound = blockOutbound();
      await call(USER, handleGetPortfolioHistory({ range: "all" }));
      await call(USER, handleGetAccountHistory({ accountId: account.id, range: "all" }));
      const now = Date.now();
      await call(USER, handleGetSnapshots({ at: now, after: now - 2 * MS_PER_DAY }));
      return outbound.calls;
    };

    expect(await reads()).toEqual([]); // 还没补:缺的日子走降级链,不回源
    await drain({ kind: "daily-prices", userId: USER });
    expect(await reads()).toEqual([]); // 补齐之后:读表
  });

  it("补齐之后曲线用日价;今天没有现价 → 沿用昨天的(前向填充),不落回账本价", async () => {
    const { account } = await manualAccount(5);
    await drain({ kind: "daily-prices", userId: USER });
    blockOutbound();
    const series = await call(USER, loadManualAccountSeries(account.id));
    const last = series.at(-1);
    // 3 个币 × 1 × 100 + 欧元 100 × 1.25 —— 不是账本里的 1 / 1.1。
    expect(last?.totalUsd).toBeCloseTo(3 * 100 + 100 * 1.25);
  });

  it("加活动之后定向投一条带这个账户币 id 的 `daily-prices`", async () => {
    const { account, queue } = await manualAccount(3);
    const daily = queue.sent.filter((m) => m.job.kind === "daily-prices");
    expect(daily).toHaveLength(1);
    const [msg] = daily;
    if (msg?.job.kind !== "daily-prices") throw new Error("no daily-prices job");
    const activities = await db(USER).manual.listActivityByAccount(account.id);
    const ids = [...new Set(activities.map((a) => a.tokenId))].sort();
    expect([...(msg.job.tokenIds ?? [])].sort()).toEqual(ids);
    expect(ids).toHaveLength(4);
    expect(msg.job.userId).toBe(USER);
    expect(msg.delaySeconds).toBeUndefined();
  });

  it("改活动 / 建手记账户之后也投;卖超被拒时不投", async () => {
    const { account } = await manualAccount(3);
    const detail = await db(USER).manual.listActivityByAccount(account.id);
    const first = detail[0];
    if (!first) throw new Error("no activity");

    const edited = captureQueue();
    await call(
      USER,
      edited.provide(
        handleUpdateManualActivityAndRefill({
          activityId: first.id,
          patch: { occurredAt: first.occurredAt - 10 * MS_PER_DAY },
        }),
      ),
    );
    expect(edited.sent.map((m) => m.job.kind)).toEqual(["daily-prices"]);

    const rejected = captureQueue();
    const out = await call(
      USER,
      rejected.provide(
        handleCreateManualActivitiesAndRefill({
          accountId: account.id,
          drafts: [
            {
              token: { symbol: "BIT", unitPrice: 1, ticket: ticketOf("bitcoin") },
              kind: "reduce",
              amount: 999,
              occurredAt: Date.now(),
            },
          ],
        }),
      ),
    );
    expect(out.ok).toBe(false);
    expect(rejected.sent).toEqual([]);

    const created = captureQueue();
    const { registry } = await fakeRegistry();
    await callWithRegistry(
      USER,
      registry,
      created.provide(
        handleCreateAccountAndRefill({
          connectorId: "manual",
          label: "手记 2",
          values: {
            tokens: JSON.stringify([
              { symbol: "BTC", unitPrice: 100, amount: 2, ticket: ticketOf("bitcoin") },
            ]),
          },
        }),
      ),
    );
    expect(created.sent.map((m) => m.job.kind)).toEqual(["daily-prices"]);
  });
});
