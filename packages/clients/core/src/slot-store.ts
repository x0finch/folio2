import { Effect } from "effect";

// 时隙游标存在哪。**它的作用域就是限速的作用域**:
//   · cache(默认)—— Cache API,同一个数据中心的 isolate 共享;缓存不可用时**兜底退到 memory**
//   · memory        —— 模块级 Map,每个 isolate 一份。isolate 一回收就归零、新 isolate 开局满额
//                      突发,所以生产别单用;测试用它
//
// cache 这一档**没有原子读改写**(两个 isolate 会读到同一个游标),所以它给不了精确配额。
// 这是明知接受的:我们要的是**削峰**,不是严格限频 —— 漏出去的那几发由 429 + 重试兜。
// 真要精确得上 Durable Object(见 #17),而那需要多用户同时同步才划得来。
//
// **为什么这套不换成 Effect 的 `RateLimiter`**:那个的状态绑在 `Scope` 上、纯进程内。CF Workers
// 上每个请求可能落在新 isolate、每次 `runPromise` 是新 scope —— 额度桶会重置,等于没限。跨 isolate
// 共享游标是这里的硬需求,Effect 侧没有对应能力。所以**实现保留,接口换成 Effect 的形状**。
export interface SlotStore {
  // 把 key 的时隙游标往后推 spacingMs,返回**推之前**的值(不早于 now)——也就是本次拿到的时隙。
  //
  // **实现必须保证同一 isolate 内的原子性**:读和写之间不能有 `yield*`,否则两个并发 fiber 会读到
  // 同一个游标、各自以为拿到了那个时隙,闸就漏了。跨 isolate 的原子性做不到,也不要求(见上)。
  readonly advance: (key: string, spacingMs: number, now: number) => Effect.Effect<number>;
  // 仅测试用:清掉这个实现自己的状态。测试里传的假 store 不需要它,所以是可选的。
  readonly reset?: () => void;
}

export type StoreChoice = "cache" | "memory" | SlotStore;

interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

// —— 内存:模块级 Map,每个 isolate 一份 ——
// **抢时隙的原子性由它兜住**:整个 `advance` 是一个 `Effect.sync`,读和写在同一个同步块里,
// 中间没有让出点,所以并发 fiber 各拿一个不同的游标。cache 那份也是靠委托给它才有这个性质。
export class MemorySlotStore implements SlotStore {
  #slots = new Map<string, number>();

  advance = (key: string, spacingMs: number, now: number): Effect.Effect<number> =>
    Effect.sync(() => {
      const tat = Math.max(this.#slots.get(key) ?? now, now);
      this.#slots.set(key, tat + spacingMs); // ← 与上一行同一个同步块,这是关键
      return tat;
    });

  // 把游标抬到至少 slotAt(只抬不降)。给 CacheSlotStore 把别人的进度并进来用。
  raiseTo(key: string, slotAt: number): void {
    if (slotAt > (this.#slots.get(key) ?? Number.NEGATIVE_INFINITY)) this.#slots.set(key, slotAt);
  }

  reset = (): void => {
    this.#slots.clear();
  };
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
// 用 console.warn 而不是 Effect 的日志:它说的是**部署配错了**,一个 isolate 一次;而这条路径
// (store 内部)没有调用方的日志上下文可用。「压根没有 caches」不喊 —— 那说明不在 Workers 上
// (node 测试),不是配错。
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

  advance = (key: string, spacingMs: number, now: number): Effect.Effect<number> =>
    Effect.gen(this, function* () {
      yield* this.#seed(key);
      const tat = yield* this.#local.advance(key, spacingMs, now); // 抢:同步块,原子
      yield* this.#publish(key, tat + spacingMs, spacingMs, now);
      return tat;
    });

  reset = (): void => {
    this.#state = "unknown";
    this.#cache = undefined;
    this.#seeded.clear();
  };

  #urlFor(key: string): string {
    return CacheSlotStore.URL_PREFIX + encodeURIComponent(key);
  }

  #open(): Effect.Effect<CacheLike | undefined> {
    return Effect.suspend(() => {
      if (this.#injected) return Effect.succeed(this.#injected);
      const caches = (globalThis as { caches?: { open(n: string): Promise<CacheLike> } }).caches;
      if (!caches) {
        this.#state = "dead"; // 不在 Workers 上,不值得喊
        return Effect.succeed(undefined);
      }
      this.#cache ??= caches.open(CacheSlotStore.CACHE_NAME);
      return Effect.promise(() => this.#cache as Promise<CacheLike>);
    });
  }

  // 每个 key 只读一次共享进度 —— 否则每个请求都要付一次缓存查。读一次就够:
  // 此后本地那份会一直往前推,而它已经不是从零开始的。
  #seed(key: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (this.#seeded.has(key) || this.#state === "dead") return;
      this.#seeded.add(key);
      const cache = yield* this.#open();
      if (!cache) return;
      const hit = yield* Effect.tryPromise(() => cache.match(this.#urlFor(key))).pipe(
        // 读炸了当没有 —— 限速器不该是新的故障源。
        Effect.orElseSucceed(() => undefined),
      );
      if (!hit) return;
      const shared = Number(
        yield* Effect.orElseSucceed(
          Effect.tryPromise(() => hit.text()),
          () => "",
        ),
      );
      if (Number.isFinite(shared)) this.#local.raiseTo(key, shared);
    });
  }

  #publish(key: string, slotAt: number, spacingMs: number, now: number): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (this.#state === "dead") return;
      const cache = yield* this.#open();
      if (!cache) return;
      const url = this.#urlFor(key);
      // 存到这个游标过期为止就够了 —— 再往后它只会被 max(tat, now) 抹掉。至少 1 秒(0 = 不可缓存)。
      const ttlSec = Math.max(1, Math.ceil((slotAt - now + spacingMs) / 1000));
      const wrote = yield* Effect.tryPromise(() =>
        cache.put(
          url,
          new Response(String(slotAt), { headers: { "cache-control": `max-age=${ttlSec}` } }),
        ),
      ).pipe(
        Effect.as(true),
        // 写不进去无所谓 —— 本地那份已经记下了,退化成 memory。
        Effect.orElseSucceed(() => false),
      );
      if (!wrote || this.#state !== "unknown") return;
      const hit = yield* Effect.tryPromise(() => cache.match(url)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      this.#state = hit ? "ok" : "dead";
      if (this.#state === "dead") {
        console.warn(
          "ratelimit: Cache API writes are not sticking — throttling is per-isolate only. " +
            "On *.workers.dev every cache put/match is a silent no-op; bind a custom domain.",
        );
      }
    });
  }
}

// 模块级单例。**`memory` 和 `cache` 共用同一份内存状态** —— cache 只是在它外面加了跨 isolate 的
// 读写,所以两种模式混用也不会各记一套。
const memoryStore = new MemorySlotStore();
const cacheStore = new CacheSlotStore(memoryStore);

export function resolveStore(choice: StoreChoice | undefined): SlotStore {
  if (choice === undefined || choice === "cache") return cacheStore;
  if (choice === "memory") return memoryStore;
  return choice;
}

// 仅测试用:让各存储清掉自己的状态。生产代码勿调。
export function resetSlotStoresForTests(): void {
  memoryStore.reset();
  cacheStore.reset();
}
