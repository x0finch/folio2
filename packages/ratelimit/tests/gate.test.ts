import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bypassGatesForTests,
  defineRateLimit,
  resetGatesForTests,
  type SlotStore,
} from "../src/index";

// 时钟和 sleep 都注入 —— 于是「谁被要求等多久」是确定的数,整个文件跑不到一秒。
// 默认的 cache 档在 node 里没有 `caches`,会自己退回本地那层,所以这里显式传 store 说清意图。

function fakeClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

// 记录被要求等多久,但**不推进时间** —— 测并发时必须这样:12 个调用共享一个假时钟,
// 谁 sleep 都会推进它,读回来就分不出彼此了。
function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

beforeEach(() => {
  resetGatesForTests();
  bypassGatesForTests(false);
});

describe("摊开请求", () => {
  it("limit 1 → 均匀摊成一发一个间距", async () => {
    const t = fakeClock();
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 125, store: "memory", ...t });
    const at: number[] = [];
    for (let i = 0; i < 4; i++) await gate(async () => void at.push(t.at()));
    expect(at).toEqual([0, 125, 250, 375]);
  });

  it("limit > 1 → 头 limit 发一起走,之后才排队", async () => {
    const r = recorder();
    const gate = defineRateLimit({
      key: "k",
      limit: 5,
      interval: 1000,
      store: "memory",
      clock: () => 0,
      sleep: r.sleep,
    });
    for (let i = 0; i < 8; i++) await gate(async () => {});
    // 前 5 发不等(wait<=0 不进 sleep),第 6/7/8 发依次 200 / 400 / 600
    expect(r.waits).toEqual([200, 400, 600]);
  });

  it("闲置之后不惩罚 —— 时间早过了就立刻放行", async () => {
    const t = fakeClock();
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 125, store: "memory", ...t });
    await gate(async () => {});
    t.advance(60_000);
    const before = t.at();
    await gate(async () => {});
    expect(t.at()).toBe(before);
  });

  it("并发抢时隙不重叠 —— 这一步必须是同步的", async () => {
    const r = recorder();
    const gate = defineRateLimit({
      key: "k",
      limit: 1,
      interval: 125,
      store: "memory",
      clock: () => 0,
      sleep: r.sleep,
    });
    await Promise.all(Array.from({ length: 12 }, () => gate(async () => {})));
    // 第一发不等,其余 11 发依次错开 125ms —— 没有两个撞在一起
    expect(r.waits).toEqual(Array.from({ length: 11 }, (_, i) => (i + 1) * 125));
  });

  it("只限发送频率,不串行化请求本身", async () => {
    const gate = defineRateLimit({ key: "k", limit: 5, interval: 1000, store: "memory" });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        gate(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          inFlight--;
        }),
      ),
    );
    expect(peak).toBeGreaterThan(1); // 额度内的请求同时在飞
  });

  it("请求抛错不卡住后面的,也不吞返回值", async () => {
    const gate = defineRateLimit({ key: "k", limit: 5, interval: 1000, store: "memory" });
    await expect(
      gate(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await gate(async () => 42)).toBe(42);
  });
});

describe("按 key 分队", () => {
  it("同 key 共享一个队(不同实例也一样)—— 限速真正生效的前提", async () => {
    const r = recorder();
    const opts = {
      key: "same",
      limit: 1,
      interval: 125,
      store: "memory" as const,
      clock: () => 0,
      sleep: r.sleep,
    };
    await defineRateLimit(opts)(async () => {});
    await defineRateLimit(opts)(async () => {});
    expect(r.waits).toEqual([125]); // 第二个排在第一个后面
  });

  it("不同 key 互不影响", async () => {
    const r = recorder();
    const mk = (key: string) =>
      defineRateLimit({
        key,
        limit: 1,
        interval: 125,
        store: "memory",
        clock: () => 0,
        sleep: r.sleep,
      });
    await mk("a")(async () => {});
    await mk("b")(async () => {});
    expect(r.waits).toEqual([]);
  });

  it("subKey 分队 —— 每账户自带额度的上游用它", async () => {
    const r = recorder();
    const gate = defineRateLimit({
      key: "cex",
      limit: 1,
      interval: 125,
      store: "memory",
      clock: () => 0,
      sleep: r.sleep,
    });
    await gate(async () => {}, "a1");
    await gate(async () => {}, "a2"); // 不同账户 → 不等
    expect(r.waits).toEqual([]);
    await gate(async () => {}, "a1"); // 同账户 → 排队
    expect(r.waits).toEqual([125]);
  });
});

describe("跨 isolate 的时隙存储", () => {
  // 这一组是**为什么默认不用内存**:新 isolate 从空队列开始的话开局白给一整轮突发,
  // 而 Cloudflare 什么时候开新 isolate 我们控制不了。
  function fakeShared(initial?: number) {
    const box: { slot?: number; sets: number } = { slot: initial, sets: 0 };
    const store: SlotStore = {
      async get() {
        return box.slot;
      },
      async set(_k, at) {
        box.slot = at;
        box.sets++;
      },
    };
    return { store, box };
  }

  it("冷启时读回别人的进度 → 不白给一整轮突发", async () => {
    const { store } = fakeShared(1000); // 别的 isolate 已经排到 1000 了
    const r = recorder();
    const gate = defineRateLimit({
      key: "k",
      limit: 1,
      interval: 125,
      store,
      clock: () => 0,
      sleep: r.sleep,
    });
    await gate(async () => {});
    expect(r.waits).toEqual([1000]); // 老实等到别人腾出来
  });

  it("放行之后把新时隙播出去", async () => {
    const { store, box } = fakeShared();
    const gate = defineRateLimit({
      key: "k",
      limit: 1,
      interval: 125,
      store,
      clock: () => 0,
      sleep: async () => {},
    });
    await gate(async () => {});
    expect(box.slot).toBe(125);
    expect(box.sets).toBe(1);
  });

  it("每个 key 只读一次共享存储 —— 不给每个请求都付一次查询", async () => {
    let gets = 0;
    const store: SlotStore = {
      async get() {
        gets++;
        return undefined;
      },
      async set() {},
    };
    const gate = defineRateLimit({
      key: "k",
      limit: 10,
      interval: 1000,
      store,
      clock: () => 0,
      sleep: async () => {},
    });
    for (let i = 0; i < 5; i++) await gate(async () => {});
    expect(gets).toBe(1);
  });

  it("共享存储炸了 → 照常放行,退化成本地那层", async () => {
    const store: SlotStore = {
      async get() {
        throw new Error("store down");
      },
      async set() {
        throw new Error("store down");
      },
    };
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 125, store });
    await expect(gate(async () => "ok")).rejects.toThrow("store down");
  });

  it("node 里没有 caches → 默认档静默退回本地,**不喊也不抛**", async () => {
    // 不喊是刻意的:没有 Cache API 说明压根不在 Workers 上,那不是部署配错了。
    // 该喊的是「有 caches 但写进去读不回来」(workers.dev),那条只有 workerd 里才验得到。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = fakeClock();
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 125, ...t }); // 不传 store = cache
    await gate(async () => {});
    await gate(async () => {});
    expect(t.at()).toBe(125); // 本地那层照样摊开
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("说不通的配置立刻炸,不悄悄退化", () => {
  it.each([0, -1, 1.5])("limit = %p → 抛", (limit) => {
    expect(() => defineRateLimit({ key: "bad", limit, interval: 100 })).toThrow(/limit/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("interval = %p → 抛", (interval) => {
    expect(() => defineRateLimit({ key: "bad", limit: 1, interval })).toThrow(/interval/);
  });

  it("正常配置不抛", () => {
    expect(() => defineRateLimit({ key: "ok", limit: 1, interval: 100 })).not.toThrow();
    expect(() => defineRateLimit({ key: "ok", limit: 500, interval: 60_000 })).not.toThrow();
  });
});

describe("测试旁路", () => {
  it("开了之后直接放行,一次都不等", async () => {
    bypassGatesForTests(true);
    const t = fakeClock();
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 10_000, store: "memory", ...t });
    for (let i = 0; i < 10; i++) await gate(async () => {});
    expect(t.at()).toBe(0);
  });

  it("旁路不吞返回值,也不吞异常", async () => {
    bypassGatesForTests(true);
    const gate = defineRateLimit({ key: "k", limit: 1, interval: 10_000, store: "memory" });
    expect(await gate(async () => 42)).toBe(42);
    await expect(
      gate(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
