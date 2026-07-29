import { beforeEach, describe, expect, it, vi } from "vitest";
import { COOLDOWN_DEFAULT_MS, COOLDOWN_MAX_MS } from "../src/constants";
import { defineLimit, RateLimitedError, resetLimitsForTests } from "../src/index";
import type { CooldownStore } from "../src/types";

// 假的 Cache API。node 里没有 `caches`,而且真货的驱逐/过期不可控 —— 注入一个就能确定性地测。
function fakeCache(opts: { sticky?: boolean } = {}): CooldownStore & { puts: number } {
  const sticky = opts.sticky ?? true;
  const store = new Map<string, string>();
  return {
    puts: 0,
    async match(request) {
      const body = store.get(request);
      return body === undefined ? undefined : new Response(body);
    },
    async put(request, response) {
      this.puts++;
      // sticky:false 模拟 workers.dev —— put 不报错,但什么也没存下(静默 no-op)。
      if (sticky) store.set(request, await response.text());
    },
  };
}

const at = (t: number) => () => t;

beforeEach(() => resetLimitsForTests());

describe("冷却标记(colo 档)", () => {
  it("冷却期内 → 不发请求,抛可重试错误并带剩余毫秒", async () => {
    const cache = fakeCache();
    let now = 1000;
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: () => now,
      cache,
    });
    await limit.cooldown(5000);
    now += 2000;
    const err = await limit.acquire().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000); // 5000 写下,过了 2000
  });

  it("过期 → 正常放行", async () => {
    const cache = fakeCache();
    let now = 1000;
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: () => now,
      cache,
    });
    await limit.cooldown(1000);
    now += 1001;
    await expect(limit.acquire()).resolves.toBeUndefined();
  });

  it("Retry-After 超上限 → 冷却按上限截断,不照抄", async () => {
    const cache = fakeCache();
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache,
    });
    await limit.cooldown(10 * 60_000); // 上游说等 10 分钟
    const err = await limit.acquire().catch((e) => e);
    expect(err.retryAfterMs).toBe(COOLDOWN_MAX_MS);
  });

  it("没给时长(上游 429 不带 Retry-After)→ 用保守默认", async () => {
    const cache = fakeCache();
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache,
    });
    await limit.cooldown(undefined);
    const err = await limit.acquire().catch((e) => e);
    expect(err.retryAfterMs).toBe(COOLDOWN_DEFAULT_MS);
  });

  it("两个不同 key 的冷却互不影响", async () => {
    const cache = fakeCache();
    const make = (key: string) =>
      defineLimit({ key, scope: "colo", capacity: 1, ratePerSec: 8, clock: at(0), cache });
    await make("a").cooldown(5000);
    await expect(make("b").acquire()).resolves.toBeUndefined();
    await expect(make("a").acquire()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("冷却只躺在缓存里(本地没有)→ 照样收手,这才是「另一个 isolate 也停」", async () => {
    // 直接给一个「缓存里已经有冷却」的假货:本 isolate 的内存里什么都没写过,冷却完全来自
    // 共享缓存 —— 这正是另一个 isolate 撞了 429 之后,我们该看到的样子。
    const foreign: CooldownStore = {
      match: async () => new Response(String(4000)), // 别人写的:冷却到 4000
      put: async () => {},
    };
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(1000),
      cache: foreign,
    });
    const err = await limit.acquire().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterMs).toBe(3000);
  });

  it("冷却期内再写「剩余时长」不续期 —— 否则每次被拒都续,冷却永远不结束", async () => {
    const cache = fakeCache();
    let now = 0;
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: () => now,
      cache,
    });
    await limit.cooldown(5000); // 冷却到 5000
    now = 4000;
    const err = await limit.acquire().catch((e) => e);
    expect(err.retryAfterMs).toBe(1000);
    // 被拒的调用方(比如 http 层的 catch)拿剩余时长又写了一次 —— 不该把终点往后推
    await limit.cooldown(err.retryAfterMs);
    expect(cache.puts).toBe(1); // 只有最初那一次
    now = 5001;
    await expect(limit.acquire()).resolves.toBeUndefined(); // 到点就放行
  });

  it("更长的冷却可以覆盖更短的", async () => {
    const cache = fakeCache();
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: () => 0,
      cache,
    });
    await limit.cooldown(1000);
    await limit.cooldown(9000);
    const err = await limit.acquire().catch((e) => e);
    expect(err.retryAfterMs).toBe(9000);
  });

  it("onCooldown 钩子 → 抛调用方自己的错误类型(provider 对 sync 的契约)", async () => {
    class MyError extends Error {}
    const cache = fakeCache();
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache,
      onCooldown: (ms) => {
        throw new MyError(`cooling ${ms}`);
      },
    });
    await limit.cooldown(5000);
    await expect(limit.acquire()).rejects.toThrow("cooling 5000");
  });
});

describe("降级 —— 限速器绝不成为新的故障源", () => {
  it("没有 caches(node)→ 不抛,退化成 isolate 档,warning 只出一次", async () => {
    const log = vi.fn();
    const limit = defineLimit({ key: "k", scope: "colo", capacity: 1, ratePerSec: 8, log });
    await expect(limit.acquire()).resolves.toBeUndefined();
    await expect(limit.acquire()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("no Cache API");
  });

  it("isolate 层仍然生效 —— 就算 colo 层不可用,自己这一格也收手", async () => {
    let now = 0;
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: () => now,
    });
    await limit.cooldown(5000);
    now += 1000;
    await expect(limit.acquire()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("put 之后 match 不命中(workers.dev)→ 不抛,warning 点明要绑自定义域", async () => {
    const log = vi.fn();
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache: fakeCache({ sticky: false }),
      log,
    });
    await limit.cooldown(5000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("custom domain");
  });

  it("缓存读抛异常 → 当没冷却,照常放行", async () => {
    const broken: CooldownStore = {
      match: async () => {
        throw new Error("cache exploded");
      },
      put: async () => {},
    };
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache: broken,
    });
    await expect(limit.acquire()).resolves.toBeUndefined();
  });

  it('scope: "global" 尚未实现 → 降级成 colo 并说一声', async () => {
    const log = vi.fn();
    const cache = fakeCache();
    const limit = defineLimit({
      key: "k",
      scope: "global",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache,
      log,
    });
    expect(log.mock.calls[0][0]).toContain("not implemented");
    await limit.cooldown(5000);
    // 降级之后仍然按 colo 档工作(写进了共享缓存)
    expect(cache.puts).toBe(1);
  });
});

describe("scope: isolate —— 压根不碰缓存", () => {
  it("不读不写 Cache API(那一层的成本只有 colo 档才付)", async () => {
    const cache = fakeCache();
    const spy = vi.spyOn(cache, "match");
    const limit = defineLimit({ key: "k", capacity: 1, ratePerSec: 8, clock: at(0), cache });
    await limit.acquire();
    await limit.cooldown(5000);
    expect(spy).not.toHaveBeenCalled();
    expect(cache.puts).toBe(0);
  });

  it("但 isolate 层的冷却照样生效", async () => {
    const limit = defineLimit({ key: "k", capacity: 1, ratePerSec: 8, clock: at(0) });
    await limit.cooldown(5000);
    await expect(limit.acquire()).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("坏输入 / 坏缓存 —— 每个 catch 都得有人踩过", () => {
  it("put 抛异常 → 不抛给调用方(isolate 层已经记下了)", async () => {
    const broken: CooldownStore = {
      match: async () => undefined,
      put: async () => {
        throw new Error("cache write exploded");
      },
    };
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache: broken,
    });
    await expect(limit.cooldown(5000)).resolves.toBeUndefined();
    // 写缓存炸了不影响 isolate 层生效
    await expect(limit.acquire()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("缓存里躺着的不是数字 → 当没冷却,照常放行", async () => {
    const garbage: CooldownStore = {
      match: async () => new Response("not-a-timestamp"),
      put: async () => {},
    };
    const limit = defineLimit({
      key: "k",
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache: garbage,
    });
    await expect(limit.acquire()).resolves.toBeUndefined();
  });

  it.each([0, -1, Number.NaN])("cooldown(%p) → 退回保守默认,不产生「已过期」的冷却", async (ms) => {
    const limit = defineLimit({
      key: `k${ms}`,
      scope: "colo",
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache: fakeCache(),
    });
    await limit.cooldown(ms);
    const err = await limit.acquire().catch((e) => e);
    expect(err.retryAfterMs).toBe(COOLDOWN_DEFAULT_MS);
  });
});

describe("resetLimitsForTests 必须真的能重置", () => {
  it("清得掉已经写进缓存的冷却 —— 不然 workerd 里的测试会被上一个用例污染", async () => {
    // 真 Cache API 没有清空接口,所以这里靠换缓存 key 的「代」号让旧条目找不到。
    // 这条用**保留内容的假缓存**来验:重置之后必须放行,哪怕那条旧记录还躺在缓存里。
    const cache = fakeCache();
    const policy = {
      key: "k",
      scope: "colo" as const,
      capacity: 1,
      ratePerSec: 8,
      clock: at(0),
      cache,
    };
    await defineLimit(policy).cooldown(5000);
    await expect(defineLimit(policy).acquire()).rejects.toBeInstanceOf(RateLimitedError);

    resetLimitsForTests();
    await expect(defineLimit(policy).acquire()).resolves.toBeUndefined();
  });
});
