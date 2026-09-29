import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { JOB_LEASE_MS, JOB_MAX_RETRIES, jobRetryDelayMs } from "@/lib/server/jobs/constants";
import type { QueueMessage } from "@/lib/server/jobs/consume";
import { type Consume, runOneDueJob } from "@/lib/server/jobs/runner";
import { JobStore, type SqlLike } from "@/lib/server/jobs/store";

// 后台任务运行器(FOL-100,ADR 0058)的排队 / 重试 / 埋掉。**跑在真 SQLite 上**(`node:sqlite` 的内存库):
// DO 的 `ctx.storage.sql` 也是 SQLite,同一套 SQL 在这里执行,不靠假实现猜 `MIN` / `FILTER` / 索引的行为。
// DO 本身(alarm 怎么定、RPC 怎么进来)只是薄薄一层接线,由 e2e 的同步那几条跑通(Miniflare 真的会响 alarm)。

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
};

const T0 = 1_800_000_000_000;
let now = T0;
const clock = () => now;
let store: JobStore;

beforeEach(() => {
  now = T0;
  store = new JobStore(sqlite());
});

const add = (body: unknown, delayMs = 0) =>
  store.add([{ body: JSON.stringify(body), runAt: now + delayMs }]);

// consumer:把收到的消息记下来,按 `act` 决定下场。
const recording = (act: (m: QueueMessage) => void | Promise<void>) => {
  const seen: QueueMessage[] = [];
  const consume: Consume = async (m) => {
    seen.push(m);
    await act(m);
  };
  return { seen, consume };
};

describe("排队与领活", () => {
  it("到点的先跑;同一时刻按先来后到;没到点的不领", async () => {
    add({ n: "later" }, 5_000);
    add({ n: "first" });
    add({ n: "second" });
    const { seen, consume } = recording((m) => m.ack());

    await runOneDueJob(store, consume, clock);
    await runOneDueJob(store, consume, clock);
    const idle = await runOneDueJob(store, consume, clock);

    expect(seen.map((m) => m.body)).toEqual([{ n: "first" }, { n: "second" }]);
    expect(idle.ran).toBeNull();
    expect(store.nextRunAt()).toBe(T0 + 5_000);

    now = T0 + 5_000;
    await runOneDueJob(store, consume, clock);
    expect(seen.at(-1)?.body).toEqual({ n: "later" });
    expect(store.nextRunAt()).toBeNull();
    expect(store.counts()).toEqual({ pending: 0, dead: 0 });
  });

  it("消息体解不开 → 原样交给 consumer(它的 decodeJob 会拒掉、ack)", async () => {
    store.add([{ body: "{not json", runAt: now }]);
    const { seen, consume } = recording((m) => m.ack());
    await runOneDueJob(store, consume, clock);
    expect(seen[0]?.body).toBe("{not json");
  });
});

describe("重试:指数退避,次数用完就埋", () => {
  it("每次失败按 30s → 60s → 120s 排下一次;最后一次失败 → 埋掉,不再领", async () => {
    add({ kind: "x" });
    const { seen, consume } = recording((m) => m.retry());

    for (let attempt = 1; attempt <= JOB_MAX_RETRIES; attempt++) {
      const { ran } = await runOneDueJob(store, consume, clock);
      expect(ran).toMatchObject({ attempts: attempt, outcome: "retry" });
      expect(store.nextRunAt()).toBe(now + jobRetryDelayMs(attempt));
      now = store.nextRunAt() ?? now;
    }
    const last = await runOneDueJob(store, consume, clock);
    expect(last.ran).toMatchObject({ attempts: JOB_MAX_RETRIES + 1, outcome: "buried" });

    expect(seen.map((m) => m.attempts)).toEqual([1, 2, 3, 4]);
    expect(store.counts()).toEqual({ pending: 0, dead: 1 });
    expect(store.nextRunAt()).toBeNull();
    now += 60 * 60_000;
    expect((await runOneDueJob(store, consume, clock)).ran).toBeNull();
  });

  it("退避从**记下场那一刻**起算,不是从领活那一刻", async () => {
    add({ kind: "slow" });
    const { consume } = recording((m) => {
      now += 80_000; // 跑了 80s 才失败
      m.retry();
    });
    await runOneDueJob(store, consume, clock);
    expect(store.nextRunAt()).toBe(T0 + 80_000 + jobRetryDelayMs(1));
  });

  it("consumer 抛了 / 什么都没表态 → 都按失败算,不会悄悄丢", async () => {
    add({ n: "throws" });
    add({ n: "silent" });
    const throws: Consume = async () => {
      throw new Error("boom");
    };
    const silent: Consume = async () => {};

    expect((await runOneDueJob(store, throws, clock)).ran?.outcome).toBe("retry");
    expect((await runOneDueJob(store, silent, clock)).ran?.outcome).toBe("retry");
    expect(store.counts()).toEqual({ pending: 2, dead: 0 });
  });

  it("埋掉的保留一段时间后清掉", async () => {
    add({ kind: "doomed" });
    const { consume } = recording((m) => m.retry());
    for (let i = 0; i <= JOB_MAX_RETRIES; i++) {
      await runOneDueJob(store, consume, clock);
      now = store.nextRunAt() ?? now;
    }
    expect(store.counts().dead).toBe(1);
    store.pruneDead(now);
    expect(store.counts().dead).toBe(1); // 埋的那一刻不早于 now
    store.pruneDead(now + 1);
    expect(store.counts().dead).toBe(0);
  });
});

describe("租期:跑到一半 DO 没了", () => {
  it("领走的活在租期内不会被再领;过了租期再跑,而且那一次算数", async () => {
    add({ kind: "crashes" });
    // 模拟「领了、还没记下场,实例就没了」:只领不跑。
    expect(store.claimNext(now, JOB_LEASE_MS)?.attempts).toBe(1);

    const { seen, consume } = recording((m) => m.ack());
    now += JOB_LEASE_MS - 1;
    expect((await runOneDueJob(store, consume, clock)).ran).toBeNull();

    now += 1;
    await runOneDueJob(store, consume, clock);
    expect(seen.map((m) => m.attempts)).toEqual([2]);
  });

  it("每次都把 DO 跑崩的活,跑满次数也会被埋掉(不会无限循环)", async () => {
    add({ kind: "poison" });
    for (let i = 0; i <= JOB_MAX_RETRIES; i++) {
      expect(store.claimNext(now, JOB_LEASE_MS)).not.toBeNull();
      now += JOB_LEASE_MS;
    }
    // 第 JOB_MAX_RETRIES + 2 次:consumer 失败 → 次数早已用完 → 埋掉。
    const { consume } = recording((m) => m.retry());
    expect((await runOneDueJob(store, consume, clock)).ran?.outcome).toBe("buried");
  });
});

describe("自述", () => {
  it("上一次 alarm 的时间记得住", () => {
    expect(store.lastRanAt()).toBeNull();
    store.markRan(T0);
    store.markRan(T0 + 1);
    expect(store.lastRanAt()).toBe(T0 + 1);
  });
});
