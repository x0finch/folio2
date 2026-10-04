import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNNER_STALL_MS } from "@/lib/server/jobs/constants";
import { JobRunner } from "@/lib/server/jobs/durable";
import { createJobStore, type JobStore, type SqlLike } from "@/lib/server/jobs/store";

// 后台任务运行器那个 Durable Object 的**接线**(FOL-100,ADR 0058)。排队 / 重试的纯逻辑在
// job-runner.test.ts;这里守的是 DO 那一层薄壳有没有把它们接对:
//   · 投活 → alarm 被定在最早那件的时刻;
//   · alarm 响一次只跑一件,还有活就再定一次,没活就不定;
//   · alarm 永远正常返回(重试是运行器自己排的,不交给平台);
//   · cron 的 poke 在 alarm 链断了的时候不管 `getAlarm()` 怎么说都重定。
// DO 运行时本身(`ctx.storage`)换成假的:SQL 落在真 SQLite(`node:sqlite`,与 DO 存储同一种库),
// alarm 的读写记进数组。活的消息体故意是解不开的那种 —— 生产的 consumer 会认出来、ack 掉,不碰 D1。

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
let view: JobStore; // 与 DO 同一个库的第二个把手:只用来看表里剩什么
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

// 解不开的活:consumer 记一条 warn、ack,不出网、不碰库。
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
  it("活落进 DO 自己的表,alarm 定在最早那件的时刻", async () => {
    await runner.enqueue([
      { ...junk(1), delaySeconds: 60 },
      { ...junk(2), delaySeconds: 10 },
    ]);

    expect(view.counts()).toEqual({ pending: 2, dead: 0 });
    expect(storage.set).toEqual([T0 + 10_000]);
    expect(view.alarmAt()).toBe(T0 + 10_000);
  });

  it("已有更早的 alarm → 不再改它", async () => {
    await runner.enqueue([junk(1)]);
    await runner.enqueue([{ ...junk(2), delaySeconds: 300 }]);
    expect(storage.set).toEqual([T0]);
  });
});

describe("alarm", () => {
  it("一次只跑一件;还有活就再定 alarm,跑空了就不定", async () => {
    await runner.enqueue([junk(1), junk(2)]);
    storage.alarm = null; // 平台:alarm 正在跑时 getAlarm() 是 null

    await runner.alarm();
    expect(view.counts()).toEqual({ pending: 1, dead: 0 });
    expect(storage.set).toEqual([T0, T0]);

    storage.alarm = null;
    await runner.alarm();
    expect(view.counts()).toEqual({ pending: 0, dead: 0 });
    expect(storage.set).toHaveLength(2);
  });

  it("定不上 alarm 也正常返回(不把重试交给平台)", async () => {
    await runner.enqueue([junk(1), junk(2)]);
    storage.alarm = null;
    storage.failSetAlarm = true;

    await expect(runner.alarm()).resolves.toBeUndefined();
    expect(view.counts().pending).toBe(1);
  });
});

describe("poke", () => {
  it("alarm 链断了(自己定的时刻早过了、活还没跑)→ 不管 getAlarm() 怎么说都重定到现在", async () => {
    await runner.enqueue([junk(1)]);
    // 平台还说「有 alarm」,但它从没响过 —— 过了卡住判据那么久。
    storage.alarm = T0;
    vi.setSystemTime(T0 + RUNNER_STALL_MS + 1);

    await runner.poke();
    expect(storage.set).toEqual([T0, T0 + RUNNER_STALL_MS + 1]);
  });

  it("链是好的(alarm 刚定过)→ 不重定", async () => {
    await runner.enqueue([junk(1)]);
    vi.setSystemTime(T0 + 1_000);

    await runner.poke();
    expect(storage.set).toEqual([T0]);
  });

  it("表里没活 → 什么都不定", async () => {
    await runner.poke();
    expect(storage.set).toEqual([]);
  });
});
