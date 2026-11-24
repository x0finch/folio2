import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNNER_STALL_MS } from "@/lib/server/jobs/constants";
import { JobRunner } from "@/lib/server/jobs/durable";
import { createJobStore, type JobStore, type SqlLike } from "@/lib/server/jobs/store";

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const T0 = 1_800_000_000_000;

const sqlite = (): SqlLike => {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
};

interface FakeStorage {
  sql: SqlLike;
  alarm: number | null;
  set: number[];
  failSetAlarm: boolean;
}

let storage: FakeStorage;
let view: JobStore;
let runner: JobRunner;

const build = () => {
  const ctx = {
    storage: {
      sql: storage.sql,
      getAlarm: async () => storage.alarm,
      setAlarm: async (at: number) => {
        if (storage.failSetAlarm) throw new Error("setAlarm refused");
        storage.set.push(at);
        storage.alarm = at;
      },
    },
  };
  return new JobRunner(ctx as unknown as DurableObjectState, {} as Cloudflare.Env);
};

const junk = (n: number) => ({ job: { kind: `not-a-job-${n}` } as never });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  storage = { sql: sqlite(), alarm: null, set: [], failSetAlarm: false };
  view = createJobStore(storage.sql);
  runner = build();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enqueue", () => {
  it("jobs land in the DO's own table, the alarm is set to the earliest job's time", async () => {
    await runner.enqueue([
      { ...junk(1), delaySeconds: 60 },
      { ...junk(2), delaySeconds: 10 },
    ]);

    expect(view.counts()).toEqual({ pending: 2, dead: 0 });
    expect(storage.set).toEqual([T0 + 10_000]);
    expect(view.alarmAt()).toBe(T0 + 10_000);
  });

  it("an earlier alarm already exists: not changed", async () => {
    await runner.enqueue([junk(1)]);
    await runner.enqueue([{ ...junk(2), delaySeconds: 300 }]);
    expect(storage.set).toEqual([T0]);
  });
});

describe("alarm", () => {
  it("runs one job at a time; sets another alarm if work remains, none once drained", async () => {
    await runner.enqueue([junk(1), junk(2)]);
    storage.alarm = null;

    await runner.alarm();
    expect(view.counts()).toEqual({ pending: 1, dead: 0 });
    expect(storage.set).toEqual([T0, T0]);

    storage.alarm = null;
    await runner.alarm();
    expect(view.counts()).toEqual({ pending: 0, dead: 0 });
    expect(storage.set).toHaveLength(2);
  });

  it("failing to set the alarm still returns normally (retry is not left to the platform)", async () => {
    await runner.enqueue([junk(1), junk(2)]);
    storage.alarm = null;
    storage.failSetAlarm = true;

    await expect(runner.alarm()).resolves.toBeUndefined();
    expect(view.counts().pending).toBe(1);
  });
});

describe("poke", () => {
  it("alarm chain broken (own time long past, job still not run): reset to now whatever getAlarm() says", async () => {
    await runner.enqueue([junk(1)]);
    storage.alarm = T0;
    vi.setSystemTime(T0 + RUNNER_STALL_MS + 1);

    await runner.poke();
    expect(storage.set).toEqual([T0, T0 + RUNNER_STALL_MS + 1]);
  });

  it("chain healthy (alarm just set): not reset", async () => {
    await runner.enqueue([junk(1)]);
    vi.setSystemTime(T0 + 1_000);

    await runner.poke();
    expect(storage.set).toEqual([T0]);
  });

  it("no jobs in the table: nothing is set", async () => {
    await runner.poke();
    expect(storage.set).toEqual([]);
  });
});
