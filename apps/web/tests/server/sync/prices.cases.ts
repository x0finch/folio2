import { Oracle } from "@folio/oracle";
import { Effect, Either } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRICES_IDS_PER_MESSAGE } from "@/lib/server/jobs/constants";
import { consumeMessage, type JobMessage } from "@/lib/server/jobs/consume";
import { decodeJob, type Job } from "@/lib/server/jobs/message";
import { type Enqueued, JobQueue } from "@/lib/server/jobs/queue";
import { db } from "../_kit/db";
import { blockOutbound, json } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// 队列的 `prices` 活(FOL-87):持仓价的回源处,按 100 个一批、一条消息 ≤ 1000 个 id。
// 出网数按**真 fetch** 数(CoinGecko adapter 真在切批),不是数假上游的方法调用。

/** 免费计划一次调用的外部 subrequest 上限。一条消息 = 一次调用。 */
const FREE_PLAN_SUBREQUESTS = 50;

describe("jobs/prices", () => {
  const USER = "h-jobs-prices";

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

  /** 建 n 个认得出来的币(CoinGecko ref)并让它们出现在最新快照里 —— 这就是「持有」。 */
  const hold = async (n: number): Promise<string[]> => {
    const refs = Array.from({ length: n }, (_, i) => `coingecko/issued:coin-${i}`);
    const ids = await call(
      USER,
      Effect.flatMap(Oracle, (o) =>
        o.tokens.mint(refs.map((ref, i) => ({ ref, seed: { symbol: `C${i}` } }))),
      ),
    );
    const tokenIds = refs.map((r) => ids.get(r)).filter((id) => id !== undefined);
    expect(tokenIds).toHaveLength(n);
    const acc = await seedAccount(USER, "w", "bitcoin");
    await seedSnapshot(
      USER,
      acc.id,
      Date.now(),
      tokenIds.map((tokenId) => ({ tokenId, amount: 1, usdValue: 10 })),
    );
    return tokenIds;
  };

  // 每个被问到的 coin id 都给一个价;`/coins/markets`(元信息那半)给空表。
  // `stubOutbound` 只认「片段 → 固定响应」,这里要按 URL 里的 ids 回价,所以自己 spy 一个。
  //
  // `failFirst`:同一个 URL 的前 k 次答 503(可重试),第 k+1 次才给 —— 让 adapter 的每一发都
  // 把重试用满再成功,那才是一条消息的**最坏**出网数(code review #21)。`Infinity` = 一直挂。
  const pricedUpstream = (opts: { failFirst?: number } = {}): { calls: string[] } => {
    const calls: string[] = [];
    const seen = new Map<string, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const tries = (seen.get(url) ?? 0) + 1;
      seen.set(url, tries);
      if (tries <= (opts.failFirst ?? 0)) return json({ error: "down" }, 503);
      const u = new URL(url);
      if (u.pathname.endsWith("/simple/price")) {
        const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        return json(
          Object.fromEntries(ids.map((id) => [id, { usd: 2, last_updated_at: 1_700_000_000 }])),
        );
      }
      if (u.pathname.endsWith("/coins/markets")) return json([]);
      throw new Error(`没有为这个 URL 准备答案:${url}`);
    });
    return { calls };
  };

  const count = (calls: readonly string[], path: string) =>
    calls.filter((u) => new URL(u).pathname.endsWith(path)).length;

  beforeEach(async () => {
    blockOutbound();
    await freshUser(USER);
    await db(USER).portfolios.ensureDefault();
  });

  it("250 个持仓币 → 价 3 发(100 个一批),写进价表;不往下投", async () => {
    const tokenIds = await hold(250);
    const outbound = pricedUpstream();

    const { state, sent } = await consume({ kind: "prices", userId: USER });

    expect(state).toEqual({ acked: true, retried: false });
    expect(count(outbound.calls, "/simple/price")).toBe(3);
    expect(outbound.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    expect(sent).toEqual([]);
    const priced = await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.pricesOf(tokenIds)),
    );
    expect(priced.size).toBe(250);
    expect([...priced.values()].every((p) => p.unitPrice === 2 && !p.stale)).toBe(true);

    // 刚刷过 → 全新鲜,再跑一遍零出网(重投 / 重复投递是免费的)。
    const again = pricedUpstream();
    await consume({ kind: "prices", userId: USER });
    expect(count(again.calls, "/simple/price")).toBe(0);
  });

  it("超过一条消息的预算 → 自己刷前 1000 个,其余切块另投;每条都 ≤ 50 发", async () => {
    const n = PRICES_IDS_PER_MESSAGE + 200;
    const tokenIds = await hold(n);
    const first = pricedUpstream();

    const { sent } = await consume({ kind: "prices", userId: USER });

    expect(count(first.calls, "/simple/price")).toBe(PRICES_IDS_PER_MESSAGE / 100);
    expect(first.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    expect(sent).toHaveLength(1);
    const [follow] = sent;
    if (follow?.job.kind !== "prices" || !follow.job.tokenIds) throw new Error("no follow-up");
    expect(follow.job.tokenIds).toHaveLength(200);
    // 投出去的消息过得了自己的 schema(consumer 那一侧解得开)。
    expect(Either.isRight(decodeJob(follow.job))).toBe(true);

    const second = pricedUpstream();
    const tail = await consume(follow.job);
    expect(tail.sent).toEqual([]); // 带块的那条不再往下投
    expect(count(second.calls, "/simple/price")).toBe(2);

    const priced = await call(
      USER,
      Effect.flatMap(Oracle, (o) => o.tokens.pricesOf(tokenIds)),
    );
    expect(priced.size).toBe(n);
    // 造 1200 行币 + 快照在 workerd 的 D1 里要几秒,不是被测代码慢。
  }, 30_000);

  // 上面几条的上游从不失败,每发一次就成 —— 预算的推导里那个「× 尝试次数」从没被走到。这条
  // 让每一发都把重试用满:先用一直挂的上游量出 adapter 实际肯试几次(同一个 URL 被打了几遍),
  // 再让每个 URL 前 (N − 1) 次失败、第 N 次成功。1000 个币 → (10 + 10) × N 发;adapter 哪天
  // 把尝试次数调大,这条就会越过 50 而红,而不是像只测顺利路径那样照绿。
  it("最坏情形(每一发都把重试用满)→ 一条消息仍 ≤ 50 发", async () => {
    await hold(PRICES_IDS_PER_MESSAGE);

    const down = pricedUpstream({ failFirst: Number.POSITIVE_INFINITY });
    const probe = await consume({ kind: "prices", userId: USER });
    expect(probe.state).toEqual({ acked: true, retried: false }); // 上游挂了不是消息失败
    const [firstUrl] = down.calls;
    const attempts = down.calls.filter((u) => u === firstUrl).length;
    expect(attempts).toBeGreaterThan(1); // 真在重试(否则这条测不到它要测的)

    const flaky = pricedUpstream({ failFirst: attempts - 1 });
    const { state, sent } = await consume({ kind: "prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(sent).toEqual([]);
    const batches = PRICES_IDS_PER_MESSAGE / 100;
    expect(count(flaky.calls, "/simple/price")).toBe(batches * attempts);
    expect(count(flaky.calls, "/coins/markets")).toBe(batches * attempts);
    expect(flaky.calls.length).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    // 造 1000 行币 + 每发一次退避(250ms 起)的真等待。
  }, 60_000);

  it("没有持仓 → 一发都不出,照样 ack", async () => {
    const outbound = blockOutbound();
    const { state } = await consume({ kind: "prices", userId: USER });
    expect(state).toEqual({ acked: true, retried: false });
    expect(outbound.calls).toEqual([]);
  });

  it("超预算的块解码就拒(不会跑出 50 发去)", () => {
    const ids = (k: number) => Array.from({ length: k }, (_, i) => `t${i}`);
    const body = (k: number) => ({ kind: "prices", userId: USER, tokenIds: ids(k) });
    expect(Either.isRight(decodeJob(body(PRICES_IDS_PER_MESSAGE)))).toBe(true);
    expect(Either.isLeft(decodeJob(body(PRICES_IDS_PER_MESSAGE + 1)))).toBe(true);
  });
});
