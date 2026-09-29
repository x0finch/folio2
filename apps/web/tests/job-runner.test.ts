import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_LEASE_MS, JOB_MAX_RETRIES, jobRetryDelayMs } from "@/lib/server/jobs/constants";
import type { JobMessage } from "@/lib/server/jobs/consume";
import { type JobHandlers, runOneDueJob } from "@/lib/server/jobs/runner";
import { createJobStore, type JobStore, type SqlLike } from "@/lib/server/jobs/store";

// 后台任务运行器(FOL-100,ADR 0058)的排队 / 重试 / 埋掉。**跑在真 SQLite 上**(`node:sqlite` 的内存库):
// DO 的 `ctx.storage.sql` 也是 SQLite,同一套 SQL 在这里执行,不靠假实现猜 `MIN` / `FILTER` / 索引的行为。
// DO 本身(alarm 怎么定、RPC 怎么进来)只是薄薄一层接线,由 e2e 的同步那几条跑通(Miniflare 真的会响 alarm)。
// 时钟是全局的 `Date.now`(CODING.md:运行时全局不开注入参数)—— 这里用假时钟拨。

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
const setNow = (t: number) => vi.setSystemTime(t);
const advance = (ms: number) => setNow(Date.now() + ms);
let store: JobStore;

beforeEach(() => {
  vi.useFakeTimers();
  setNow(T0);
  store = createJobStore(sqlite());
});

afterEach(() => {
  vi.useRealTimers();
});

const add = (body: unknown, delayMs = 0) =>
  store.add([{ body: JSON.stringify(body), runAt: Date.now() + delayMs }]);

// handlers:把收到的消息记下来,consume 按 `act` 决定下场;abandon 只记。
const recording = (act: (m: JobMessage) => void | Promise<void>) => {
  const seen: JobMessage[] = [];
  const abandoned: { message: JobMessage; reason: string }[] = [];
  const handlers: JobHandlers = {
    consume: async (m) => {
      seen.push(m);
      await act(m);
    },
    abandon: async (message, reason) => {
      abandoned.push({ message, reason });
    },
  };
  return { seen, abandoned, handlers };
};

describe("排队与领活", () => {
  it("到点的先跑;同一时刻按先来后到;没到点的不领", async () => {
    add({ n: "later" }, 5_000);
    add({ n: "first" });
    add({ n: "second" });
    const { seen, handlers } = recording((m) => m.ack());

    await runOneDueJob(store, handlers);
    await runOneDueJob(store, handlers);
    const idle = await runOneDueJob(store, handlers);

    expect(seen.map((m) => m.body)).toEqual([{ n: "first" }, { n: "second" }]);
    expect(idle.ran).toBeNull();
    expect(store.nextRunAt()).toBe(T0 + 5_000);

    setNow(T0 + 5_000);
    await runOneDueJob(store, handlers);
    expect(seen.at(-1)?.body).toEqual({ n: "later" });
    expect(store.nextRunAt()).toBeNull();
    expect(store.counts()).toEqual({ pending: 0, dead: 0 });
  });

  it("消息体解不开 → 原样交给 consumer(它的 decodeJob 会拒掉、ack)", async () => {
    store.add([{ body: "{not json", runAt: Date.now() }]);
    const { seen, handlers } = recording((m) => m.ack());
    await runOneDueJob(store, handlers);
    expect(seen[0]?.body).toBe("{not json");
  });
});

describe("重试:指数退避,次数用完就埋", () => {
  it("每次失败按 30s → 60s → 120s 排下一次;最后一次失败 → 埋掉,不再领", async () => {
    add({ kind: "x" });
    const { seen, abandoned, handlers } = recording((m) => m.retry());

    for (let attempt = 1; attempt <= JOB_MAX_RETRIES; attempt++) {
      const { ran } = await runOneDueJob(store, handlers);
      expect(ran).toMatchObject({ attempts: attempt, outcome: "retry" });
      expect(store.nextRunAt()).toBe(Date.now() + jobRetryDelayMs(attempt));
      setNow(store.nextRunAt() ?? Date.now());
    }
    const last = await runOneDueJob(store, handlers);
    expect(last.ran).toMatchObject({ attempts: JOB_MAX_RETRIES + 1, outcome: "buried" });

    expect(seen.map((m) => m.attempts)).toEqual([1, 2, 3, 4]);
    expect(abandoned).toEqual([]); // 跑完了最后一次,收尾是 consumer 自己做的
    expect(store.counts()).toEqual({ pending: 0, dead: 1 });
    expect(store.nextRunAt()).toBeNull();
    advance(60 * 60_000);
    expect((await runOneDueJob(store, handlers)).ran).toBeNull();
  });

  it("退避从**记下场那一刻**起算,不是从领活那一刻", async () => {
    add({ kind: "slow" });
    const { handlers } = recording((m) => {
      advance(80_000); // 跑了 80s 才失败
      m.retry();
    });
    await runOneDueJob(store, handlers);
    expect(store.nextRunAt()).toBe(T0 + 80_000 + jobRetryDelayMs(1));
  });

  it("consumer 抛了 / 什么都没表态 → 都按失败算,不会悄悄丢", async () => {
    add({ n: "throws" });
    add({ n: "silent" });
    const throws: JobHandlers = {
      consume: async () => {
        throw new Error("boom");
      },
      abandon: async () => {},
    };
    const silent: JobHandlers = { consume: async () => {}, abandon: async () => {} };

    expect((await runOneDueJob(store, throws)).ran?.outcome).toBe("retry");
    expect((await runOneDueJob(store, silent)).ran?.outcome).toBe("retry");
    expect(store.counts()).toEqual({ pending: 2, dead: 0 });
  });

  it("埋掉的保留一段时间后清掉", async () => {
    add({ kind: "doomed" });
    const { handlers } = recording((m) => m.retry());
    for (let i = 0; i <= JOB_MAX_RETRIES; i++) {
      await runOneDueJob(store, handlers);
      setNow(store.nextRunAt() ?? Date.now());
    }
    expect(store.counts().dead).toBe(1);
    store.pruneDead(Date.now());
    expect(store.counts().dead).toBe(1); // 埋的那一刻不早于 now
    store.pruneDead(Date.now() + 1);
    expect(store.counts().dead).toBe(0);
  });
});

describe("租期:跑到一半 DO 没了", () => {
  it("领走的活在租期内不会被再领;过了租期再跑,而且那一次算数", async () => {
    add({ kind: "crashes" });
    // 模拟「领了、还没记下场,实例就没了」:只领不跑。
    expect(store.claimNext(Date.now(), JOB_LEASE_MS)?.attempts).toBe(1);

    const { seen, handlers } = recording((m) => m.ack());
    advance(JOB_LEASE_MS - 1);
    expect((await runOneDueJob(store, handlers)).ran).toBeNull();

    advance(1);
    await runOneDueJob(store, handlers);
    expect(seen.map((m) => m.attempts)).toEqual([2]);
  });

  it("每次都把 DO 跑崩的活:最后一次也没跑完 → 下次领到时不再跑,收尾后埋掉", async () => {
    add({ kind: "poison" });
    // 1 … JOB_MAX_RETRIES + 1 次:每次都是「领了就死」(没记下场)。
    for (let i = 0; i <= JOB_MAX_RETRIES; i++) {
      expect(store.claimNext(Date.now(), JOB_LEASE_MS)).not.toBeNull();
      advance(JOB_LEASE_MS);
    }
    const { seen, abandoned, handlers } = recording((m) => m.ack());
    const { ran } = await runOneDueJob(store, handlers);

    expect(ran?.outcome).toBe("buried");
    expect(seen).toEqual([]); // 没再跑
    expect(abandoned).toHaveLength(1); // 先收尾(sync-account:账户记 failed)
    expect(abandoned[0]?.message.body).toEqual({ kind: "poison" });
    expect(store.counts()).toEqual({ pending: 0, dead: 1 });
  });

  it("收尾自己抛了也照埋 —— 埋掉才是止损", async () => {
    add({ kind: "poison" });
    for (let i = 0; i <= JOB_MAX_RETRIES; i++) {
      store.claimNext(Date.now(), JOB_LEASE_MS);
      advance(JOB_LEASE_MS);
    }
    const handlers: JobHandlers = {
      consume: async () => {},
      abandon: async () => {
        throw new Error("give-up exploded");
      },
    };
    expect((await runOneDueJob(store, handlers)).ran?.outcome).toBe("buried");
    expect(store.counts().dead).toBe(1);
  });
});

describe("自己记下的 alarm 时刻", () => {
  it("记得住最后一次定的", () => {
    expect(store.alarmAt()).toBeNull();
    store.noteAlarm(T0);
    store.noteAlarm(T0 + 1);
    expect(store.alarmAt()).toBe(T0 + 1);
  });
});
