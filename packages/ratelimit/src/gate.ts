import type { Gate, RateLimitOptions, SlotStore, StoreChoice } from "./types";

// 出站请求的速率闸。**目标是削峰,不是严格限频** —— 严格那档在 Workers 上只有 Durable Object 能做
// (见 #17),而我们不需要:漏出去的那几发由 429 + `withRetry` 兜底。
//
// 算的东西只有一个数:**下一个可用时隙**(tat, theoretical arrival time)。
//   · 放行时刻 = tat - 突发额度,早于 now 就是不用等
//   · 每放行一发,tat 往后推一个间距
//   · tat 先 max(tat, now) —— 闲置过后 tat 落在过去,突发额度自动补满(不惩罚闲置)
//
// **两层状态,各管一件事**:
//   ① 模块级 Map —— **同步**抢时隙。并发调用各拿一个不同时隙,这一层必须是同步的,
//      否则两个并发调用会 await 到同一个时隙上去
//   ② 跨 isolate 的 store(默认 Cache API)—— 把时隙**播出去**,也在 isolate 冷启时**读回来**。
//      没有它的话每个新 isolate 都从空队列开始、开局满额突发,而 Cloudflare 什么时候开新
//      isolate 我们控制不了 —— 那等于没限。它非原子(两个 isolate 会读到同一个时隙),
//      但削峰不要求精确
//
// 换句话说:①保证「同一次同步里不互挤」,②保证「换了 isolate 不白给一整轮突发」。

const localSlots = new Map<string, number>();
const seeded = new Set<string>();

const CACHE_NAME = "folio-ratelimit";
const URL_PREFIX = "https://ratelimit.folio.internal/slot/";
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// —— memory 档:模块级 Map,每个 isolate 一份 ——
const memoryStore: SlotStore = {
  async get(key) {
    return localSlots.get(key);
  },
  async set(key, slotAt) {
    localSlots.set(key, slotAt);
  },
};

// —— cache 档:Cache API,同 colo 的 isolate 共享 ——
// **`*.workers.dev` 上 Cache API 的 put/match 是静默 no-op**(见 apps/web/DEPLOY.md),所以第一次
// 写完要探一下命中;不命中就退回 memory 并喊一声。不喊的话这一档看着在跑、实际是死的,
// 而下次查限流会查错方向。用 console.warn 而不是接日志系统:它说的是**部署配的不对**,
// 一个 isolate 一次,不值得为它铺一层注入。
let cacheState: "unknown" | "ok" | "dead" = "unknown";
let cachePromise: Promise<CacheLike | undefined> | undefined;

interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

async function openCache(): Promise<CacheLike | undefined> {
  const caches = (globalThis as { caches?: { open(n: string): Promise<CacheLike> } }).caches;
  if (!caches) {
    // 压根没有 Cache API → 不在 Workers 上(node 测试)。**这不值得喊** —— 它不是部署配错了。
    // 该喊的是下面那种:有 caches,但写进去读不回来(= workers.dev 上的静默 no-op)。
    cacheState = "dead";
    return undefined;
  }
  cachePromise ??= caches.open(CACHE_NAME);
  return cachePromise;
}

const cacheStore: SlotStore = {
  async get(key) {
    if (cacheState === "dead") return undefined;
    const cache = await openCache();
    if (!cache) return undefined;
    try {
      const hit = await cache.match(URL_PREFIX + encodeURIComponent(key));
      if (!hit) return undefined;
      const n = Number(await hit.text());
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined; // 缓存读炸了当没有 —— 限速器不该是新的故障源
    }
  },
  async set(key, slotAt, ttlMs) {
    if (cacheState === "dead") return;
    const cache = await openCache();
    if (!cache) return;
    const url = URL_PREFIX + encodeURIComponent(key);
    try {
      await cache.put(
        url,
        // max-age 让它自己过期,不用我们清理。至少 1 秒(0 会被当成不可缓存)。
        new Response(String(slotAt), {
          headers: { "cache-control": `max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}` },
        }),
      );
      if (cacheState === "unknown") {
        cacheState = (await cache.match(url)) ? "ok" : "dead";
        if (cacheState === "dead") {
          console.warn(
            "ratelimit: Cache API writes are not sticking — throttling is per-isolate only. " +
              "On *.workers.dev every cache put/match is a silent no-op; bind a custom domain.",
          );
        }
      }
    } catch {
      // 写不进去无所谓 —— 本地那层已经记下了,退化成 memory 档。
    }
  },
};

function resolveStore(choice: StoreChoice | undefined): SlotStore {
  if (choice === undefined || choice === "cache") return cacheStore;
  if (choice === "memory") return memoryStore;
  return choice;
}

// 仅测试用:清空本地时隙 + 缓存探测状态。生产代码勿调。
export function resetGatesForTests(): void {
  localSlots.clear();
  seeded.clear();
  cacheState = "unknown";
  cachePromise = undefined;
}

// 仅测试用:让所有闸直接放行。集成测试跑的是应用真实接线,那条路上没有测试参数可传,
// 而闸真等的话那套会从 1 秒涨到几十秒。限速本身在本包的单测里验。
let bypass = false;
export function bypassGatesForTests(on: boolean): void {
  bypass = on;
}

export function defineRateLimit(opts: RateLimitOptions): Gate {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new Error(`ratelimit: limit must be an integer >= 1 (${opts.key})`);
  }
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) {
    throw new Error(`ratelimit: interval must be a positive finite number (${opts.key})`);
  }

  const store = resolveStore(opts.store);
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const spacing = opts.interval / opts.limit;
  const burst = (opts.limit - 1) * spacing;

  return async <T>(run: () => Promise<T>, subKey?: string): Promise<T> => {
    if (bypass) return run();
    const key = subKey === undefined ? opts.key : `${opts.key}:${subKey}`;

    // isolate 冷启时把别人的进度读回来,每个 key 只读一次 —— 否则每个请求都要付一次缓存查。
    // 读一次就够了:此后本地那层会一直往前推,而它已经不是从零开始。
    if (!seeded.has(key)) {
      seeded.add(key);
      const shared = await store.get(key);
      if (shared !== undefined) {
        localSlots.set(key, Math.max(localSlots.get(key) ?? 0, shared));
      }
    }

    // **抢时隙这一步必须同步**(算完立刻写回本地)→ 并发调用各拿一个不同的时隙。
    const now = clock();
    const tat = Math.max(localSlots.get(key) ?? now, now);
    const releaseAt = tat - burst;
    const nextTat = tat + spacing;
    localSlots.set(key, nextTat);

    // 播给同 colo 的其他 isolate。失败无所谓(store 自己吞掉),不阻塞放行判断。
    await store.set(key, nextTat, opts.interval + spacing);

    const waitMs = releaseAt - now;
    if (waitMs > 0) await sleep(waitMs);
    return run();
  };
}
