import type { RateLimiter, RateLimitOptions, SlotStore, StoreChoice } from "./types";

// 出站请求的速率闸。**目标是削峰,不是严格限频** —— 严格那档在 Workers 上只有 Durable Object 能做
// (见 #17),而我们不需要:漏出去的那几发由 429 + `withRetry` 兜底。
//
// 算的东西只有一个数:**时隙游标**(tat, theoretical arrival time)。
//   · 本次拿到的时隙 = 推之前的游标(不早于 now);放行时刻 = 它 - 突发额度
//   · 每放行一发,游标往后推一个间距
//   · 游标不早于 now —— 闲置过后它落在过去,突发额度自动补满(不惩罚闲置)
//
// 游标存哪由 `store` 决定,两种实现都在下面。**内存那份是真实现,不是占位** ——
// cache 那份把真正的「抢」委托给它,自己只管跨 isolate 的读回来和播出去。

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

// —— 内存:模块级 Map,每个 isolate 一份 ——
// **抢时隙的原子性由它兜住**:`advance` 里读和写之间没有 `await`,所以并发调用各拿一个不同的
// 游标。cache 那份也是靠委托给它才有这个性质。
export class MemorySlotStore implements SlotStore {
  #slots = new Map<string, number>();

  async advance(key: string, spacingMs: number, now: number): Promise<number> {
    const tat = Math.max(this.#slots.get(key) ?? now, now);
    this.#slots.set(key, tat + spacingMs); // ← 与上一行之间没有 await,这是关键
    return tat;
  }

  // 把游标抬到至少 slotAt(只抬不降)。给 CacheSlotStore 把别人的进度并进来用。
  raiseTo(key: string, slotAt: number): void {
    if (slotAt > (this.#slots.get(key) ?? Number.NEGATIVE_INFINITY)) this.#slots.set(key, slotAt);
  }

  reset(): void {
    this.#slots.clear();
  }
}

// —— Cache API:同一个数据中心的 isolate 共享 ——
// 它**不自己存游标**:抢仍然委托给内存那份(要那份的原子性),自己只做两件跨 isolate 的事 ——
// 冷启时把别人的进度读回来、抢完把新游标播出去。缓存不可用时就只剩委托,也就是自动兜底成 memory。
//
// 没有它的话每个新 isolate 都从零开始、开局满额突发,而 Cloudflare 什么时候开新 isolate 我们
// 控制不了 —— 那等于没限。
//
// **`*.workers.dev` 上 put/match 是静默 no-op**(见 apps/web/DEPLOY.md),所以第一次写完探一下命中,
// 不命中就把自己标死并喊一声 —— 不喊的话这一档看着在跑、实际是死的,下次查限流会查错方向。
// 用 console.warn 而不是接日志系统:它说的是**部署配错了**,一个 isolate 一次,不值得铺一层注入。
// 「压根没有 caches」不喊 —— 那说明不在 Workers 上(node 测试),不是配错。
export class CacheSlotStore implements SlotStore {
  static readonly CACHE_NAME = "folio-ratelimit";
  static readonly URL_PREFIX = "https://ratelimit.folio.internal/slot/";

  #local: MemorySlotStore;
  #injected: CacheLike | undefined;
  #state: "unknown" | "ok" | "dead" = "unknown";
  #cache: Promise<CacheLike | undefined> | undefined;
  #seeded = new Set<string>();

  // local 显式传进来 —— 生产传模块级那个单例,测试可以给一份干净的。
  constructor(local: MemorySlotStore, cache?: CacheLike) {
    this.#local = local;
    this.#injected = cache;
  }

  async advance(key: string, spacingMs: number, now: number): Promise<number> {
    await this.#seed(key);
    const tat = await this.#local.advance(key, spacingMs, now); // 抢:同步、原子
    await this.#publish(key, tat + spacingMs, spacingMs);
    return tat;
  }

  reset(): void {
    this.#state = "unknown";
    this.#cache = undefined;
    this.#seeded.clear();
  }

  #urlFor(key: string): string {
    return CacheSlotStore.URL_PREFIX + encodeURIComponent(key);
  }

  async #open(): Promise<CacheLike | undefined> {
    if (this.#injected) return this.#injected;
    const caches = (globalThis as { caches?: { open(n: string): Promise<CacheLike> } }).caches;
    if (!caches) {
      this.#state = "dead"; // 不在 Workers 上,不值得喊
      return undefined;
    }
    this.#cache ??= caches.open(CacheSlotStore.CACHE_NAME);
    return this.#cache;
  }

  // 每个 key 只读一次共享进度 —— 否则每个请求都要付一次缓存查。读一次就够:
  // 此后本地那份会一直往前推,而它已经不是从零开始的。
  async #seed(key: string): Promise<void> {
    if (this.#seeded.has(key) || this.#state === "dead") return;
    this.#seeded.add(key);
    const cache = await this.#open();
    if (!cache) return;
    try {
      const hit = await cache.match(this.#urlFor(key));
      if (!hit) return;
      const shared = Number(await hit.text());
      if (Number.isFinite(shared)) this.#local.raiseTo(key, shared);
    } catch {
      // 读炸了当没有 —— 限速器不该是新的故障源。
    }
  }

  async #publish(key: string, slotAt: number, spacingMs: number): Promise<void> {
    if (this.#state === "dead") return;
    const cache = await this.#open();
    if (!cache) return;
    const url = this.#urlFor(key);
    // 存到这个游标过期为止就够了 —— 再往后它只会被 max(tat, now) 抹掉。至少 1 秒(0 = 不可缓存)。
    const ttlSec = Math.max(1, Math.ceil((slotAt - Date.now() + spacingMs) / 1000));
    try {
      await cache.put(
        url,
        new Response(String(slotAt), { headers: { "cache-control": `max-age=${ttlSec}` } }),
      );
      if (this.#state === "unknown") {
        this.#state = (await cache.match(url)) ? "ok" : "dead";
        if (this.#state === "dead") {
          console.warn(
            "ratelimit: Cache API writes are not sticking — throttling is per-isolate only. " +
              "On *.workers.dev every cache put/match is a silent no-op; bind a custom domain.",
          );
        }
      }
    } catch {
      // 写不进去无所谓 —— 本地那份已经记下了,退化成 memory。
    }
  }
}

// 模块级单例。**`memory` 和 `cache` 共用同一份内存状态** —— cache 只是在它外面加了跨 isolate 的
// 读写,所以两种模式混用也不会各记一套。
const memoryStore = new MemorySlotStore();
const cacheStore = new CacheSlotStore(memoryStore);

function resolveStore(choice: StoreChoice | undefined): SlotStore {
  if (choice === undefined || choice === "cache") return cacheStore;
  if (choice === "memory") return memoryStore;
  return choice;
}

// 仅测试用:让各存储清掉自己的状态。生产代码勿调。
export function resetRateLimitsForTests(): void {
  memoryStore.reset();
  cacheStore.reset();
}

// 仅测试用:让所有闸直接放行。集成测试跑的是应用真实接线,那条路上没有测试参数可传,
// 而闸真等的话那套会从 1 秒涨到几十秒。限速本身在本包的单测里验。
let bypass = false;
export function bypassRateLimitsForTests(on: boolean): void {
  bypass = on;
}

export function defineRateLimit(opts: RateLimitOptions): RateLimiter {
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
    const now = clock();
    const tat = await store.advance(key, spacing, now);
    const waitMs = tat - burst - now;
    if (waitMs > 0) await sleep(waitMs);
    return run();
  };
}
