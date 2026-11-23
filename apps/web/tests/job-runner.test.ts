import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_LEASE_MS, JOB_MAX_RETRIES, jobRetryDelayMs } from "@/lib/server/jobs/constants";
import type { JobMessage } from "@/lib/server/jobs/consume";
import { alarmToSet, isStalled, type JobHandlers, runOneDueJob } from "@/lib/server/jobs/runner";
import { createJobStore, type JobStore, type SqlLike } from "@/lib/server/jobs/store";

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

const recording = (act: (m: JobMessage) => void | Promise<void>) => {
  const seen: JobMessage[] = [];
  const abandoned: { message: Omit<JobMessage, "ack" | "retry">; reason: string }[] = [];
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

describe("queueing and claiming", () => {
  it("due ones run first; ties in arrival order; not-yet-due ones are not claimed", async () => {
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

  it("undecodable message body: handed to the consumer as is (its decodeJob rejects and acks)", async () => {
    store.add([{ body: "{not json", runAt: Date.now() }]);
    const { seen, handlers } = recording((m) => m.ack());
    await runOneDueJob(store, handlers);
    expect(seen[0]?.body).toBe("{not json");
  });
});

describe("retry: exponential backoff, buried once attempts run out", () => {
  it("each failure schedules the next at 30s, 60s, 120s; last failure: buried, no longer claimed", async () => {
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
    expect(abandoned).toEqual([]);
    expect(store.counts()).toEqual({ pending: 0, dead: 1 });
    expect(store.nextRunAt()).toBeNull();
    advance(60 * 60_000);
    expect((await runOneDueJob(store, handlers)).ran).toBeNull();
  });

  it("backoff counts from **the moment the failure is recorded**, not from when the job was claimed", async () => {
    add({ kind: "slow" });
    const { handlers } = recording((m) => {
      advance(80_000);
      m.retry();
    });
    await runOneDueJob(store, handlers);
    expect(store.nextRunAt()).toBe(T0 + 80_000 + jobRetryDelayMs(1));
  });

  it("consumer throws / states nothing: both count as failure, never silently dropped", async () => {
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

  it("buried jobs are purged after a retention period", async () => {
    add({ kind: "doomed" });
    const { handlers } = recording((m) => m.retry());
    for (let i = 0; i <= JOB_MAX_RETRIES; i++) {
      await runOneDueJob(store, handlers);
      setNow(store.nextRunAt() ?? Date.now());
    }
    expect(store.counts().dead).toBe(1);
    store.pruneDead(Date.now());
    expect(store.counts().dead).toBe(1);
    store.pruneDead(Date.now() + 1);
    expect(store.counts().dead).toBe(0);
  });
});

describe("lease: the DO dies mid-run", () => {
  it("a claimed job is not reclaimed within its lease; after the lease it runs again, and that attempt counts", async () => {
    add({ kind: "crashes" });
    expect(store.claimNext(Date.now(), JOB_LEASE_MS)?.attempts).toBe(1);

    const { seen, handlers } = recording((m) => m.ack());
    advance(JOB_LEASE_MS - 1);
    expect((await runOneDueJob(store, handlers)).ran).toBeNull();

    advance(1);
    await runOneDueJob(store, handlers);
    expect(seen.map((m) => m.attempts)).toEqual([2]);
  });

  it("a job that crashes the DO every time: the last attempt also never finished, so next claim it does not run, and is buried after cleanup", async () => {
    add({ kind: "poison" });
    for (let i = 0; i <= JOB_MAX_RETRIES; i++) {
      expect(store.claimNext(Date.now(), JOB_LEASE_MS)).not.toBeNull();
      advance(JOB_LEASE_MS);
    }
    const { seen, abandoned, handlers } = recording((m) => m.ack());
    const { ran } = await runOneDueJob(store, handlers);

    expect(ran?.outcome).toBe("buried");
    expect(seen).toEqual([]);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.message.body).toEqual({ kind: "poison" });
    expect(store.counts()).toEqual({ pending: 0, dead: 1 });
  });

  it("buried even if the cleanup itself throws: burying is the loss cut", async () => {
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
    const { ran } = await runOneDueJob(store, handlers);
    expect(ran?.outcome).toBe("buried");
    expect(ran?.abandonError).toBe("give-up exploded");
    expect(store.counts().dead).toBe(1);
  });
});

describe("what time to set the alarm (alarmToSet)", () => {
  const now = T0;
  it("no jobs: not set", () => {
    expect(alarmToSet({ due: null, current: null, now })).toBeNull();
  });
  it("no alarm (or inside an alarm, getAlarm is null): set to the earliest job, but not earlier than now", () => {
    expect(alarmToSet({ due: now + 5_000, current: null, now })).toBe(now + 5_000);
    expect(alarmToSet({ due: now - 5_000, current: null, now })).toBe(now);
  });
  it("an existing alarm no later than it: unchanged; an existing later one: moved earlier", () => {
    expect(alarmToSet({ due: now + 5_000, current: now + 1_000, now })).toBeNull();
    expect(alarmToSet({ due: now + 5_000, current: now + 5_000, now })).toBeNull();
    expect(alarmToSet({ due: now + 5_000, current: now + 60_000, now })).toBe(now + 5_000);
  });
});

describe("whether it is stuck (isStalled)", () => {
  const now = T0;
  const stallMs = 15 * 60_000;
  it("due jobs exist, the self-set alarm should have fired and is past the window without refresh: stuck", () => {
    expect(isStalled({ due: now - 1, armedAt: now - stallMs, now, stallMs })).toBe(true);
  });
  it("never set an alarm yet there are due jobs: stuck", () => {
    expect(isStalled({ due: now, armedAt: null, now, stallMs })).toBe(true);
  });
  it("within the window / job not yet due / no jobs: not stuck", () => {
    expect(isStalled({ due: now - 1, armedAt: now - stallMs + 1, now, stallMs })).toBe(false);
    expect(isStalled({ due: now + 1, armedAt: now - 2 * stallMs, now, stallMs })).toBe(false);
    expect(isStalled({ due: null, armedAt: null, now, stallMs })).toBe(false);
  });
});

describe("the alarm time it records itself", () => {
  it("remembers the last one set", () => {
    expect(store.alarmAt()).toBeNull();
    store.noteAlarm(T0);
    store.noteAlarm(T0 + 1);
    expect(store.alarmAt()).toBe(T0 + 1);
  });
});
