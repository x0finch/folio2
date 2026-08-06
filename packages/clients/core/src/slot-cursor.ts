import { Context, Effect, Option } from "effect";

// `isolated` 档的状态:每个 key 一个**时隙游标**(一个数)。
//
// 为什么是一个数:跨 isolate 共享的载体是 Cloudflare Cache API,它只能存值、没有原子读改写。
// 一个数能存进去,信号量不能 —— 这就是 `isolated` 档用 GCRA 而不是官方那套 semaphore 的原因
// (见 ratelimit.ts)。
//
// **抢时隙的原子性由本地那份兜住**:`advance` 里读写 `tat` 在同一个 `Effect.sync` 块内,中间没有
// 让出点,所以并发 fiber 各拿一个不同的游标。跨 isolate 的原子性做不到(两个 isolate 会读到同一个
// 游标),也不要求 —— 目标是削峰,漏出去的那几发由 429 + 重试兜。

// Cache API 的最小形状。
export interface SlotCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

// **可选服务** —— `Effect.serviceOption` 读它,所以 **`R` 通道不受污染**(不 provide 也能跑)。
// 生产不 provide,回退到 `globalThis.caches`;测试 provide 一份假的来验跨 isolate 的读写行为。
// 这替掉了「构造器注入 + 模块级单例 + resetForTests」那一套全局可变状态。
export class SlotCacheOverride extends Context.Tag("client-core/SlotCacheOverride")<
  SlotCacheOverride,
  SlotCache
>() {}

const CACHE_NAME = "folio-ratelimit";
// 导出给测试:要预置「别的 isolate 已经用掉一段额度」的缓存条目,就得能算出它的 URL。
export const SLOT_URL_PREFIX = "https://ratelimit.folio.internal/slot/";
const URL_PREFIX = SLOT_URL_PREFIX;

export interface SlotCursor {
  // 把游标往后推 spacingMs,返回**推之前**的值(不早于 now)—— 也就是本次拿到的时隙。
  readonly advance: (spacingMs: number, now: number) => Effect.Effect<number>;
}

// 游标按 key 存,**模块级、跨 `make` 调用共享**。CF Workers 上每个请求一次 `runPromise`,
// 状态放 `Scope` 或 Layer 里就等于每请求重置 —— 那正是要避免的。
const cursors = new Map<string, SlotCursor>();

// 测试之间靠**用不同的 key** 隔离,不提供 reset:少一个全局可变开关,也少一条「忘了 reset 就串味」
// 的路。(node 测试里 `globalThis.caches` 不存在,这一档自动退化成纯内存,不同 key 即完全隔离。)
export function cursorFor(key: string): SlotCursor {
  const found = cursors.get(key);
  if (found) return found;
  const created = makeCursor(key);
  cursors.set(key, created);
  return created;
}

function makeCursor(key: string): SlotCursor {
  const url = URL_PREFIX + encodeURIComponent(key);
  let tat = Number.NEGATIVE_INFINITY;
  let seeded = false;
  // "unknown" 还没探过写进没进去;"dead" 别再试(不在 Workers 上,或写不生效)。
  let health: "unknown" | "ok" | "dead" = "unknown";
  let opening: Promise<SlotCache | undefined> | undefined;

  const open = (): Effect.Effect<SlotCache | undefined> =>
    Effect.gen(function* () {
      const override = yield* Effect.serviceOption(SlotCacheOverride);
      if (Option.isSome(override)) return override.value;
      if (health === "dead") return undefined;
      const caches = (globalThis as { caches?: { open(n: string): Promise<SlotCache> } }).caches;
      if (!caches) {
        health = "dead"; // 不在 Workers 上(node 测试),不是配错,不喊
        return undefined;
      }
      opening ??= caches.open(CACHE_NAME);
      return yield* Effect.promise(() => opening as Promise<SlotCache>);
    });

  // 每个 key 只读一次共享进度 —— 否则每个请求都要付一次缓存查。读一次就够:此后本地那份会一直
  // 往前推,而它已经不是从零开始的。读炸了当没有 —— 限速器不该是新的故障源。
  const seed = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (seeded) return;
      seeded = true;
      const cache = yield* open();
      if (!cache) return;
      const hit = yield* Effect.tryPromise(() => cache.match(url)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!hit) return;
      const text = yield* Effect.tryPromise(() => hit.text()).pipe(Effect.orElseSucceed(() => ""));
      const shared = Number(text);
      if (Number.isFinite(shared) && shared > tat) tat = shared; // 只抬不降
    });

  // 抢完把新游标播出去。
  //
  // **`*.workers.dev` 上 put/match 是静默 no-op**(见 apps/web/DEPLOY.md),所以第一次写完探一下命中,
  // 不命中就把自己标死并喊一声 —— 不喊的话这一档看着在跑、实际是死的,下次查限流会查错方向。
  // 用 console.warn 而不是 Effect 的日志:它说的是**部署配错了**,一个 isolate 一次,而这条路径
  // 没有调用方的日志上下文可用。
  const publish = (slotAt: number, spacingMs: number, now: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const cache = yield* open();
      if (!cache) return;
      // 存到这个游标过期为止就够了 —— 再往后它只会被 max(tat, now) 抹掉。至少 1 秒(0 = 不可缓存)。
      const ttlSec = Math.max(1, Math.ceil((slotAt - now + spacingMs) / 1000));
      const wrote = yield* Effect.tryPromise(() =>
        cache.put(
          url,
          new Response(String(slotAt), { headers: { "cache-control": `max-age=${ttlSec}` } }),
        ),
      ).pipe(
        Effect.as(true),
        // 写不进去无所谓 —— 本地那份已经记下了,退化成每 isolate 一份。
        Effect.orElseSucceed(() => false),
      );
      if (!wrote || health !== "unknown") return;
      const hit = yield* Effect.tryPromise(() => cache.match(url)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      health = hit ? "ok" : "dead";
      if (health === "dead") {
        console.warn(
          "ratelimit: Cache API writes are not sticking — throttling is per-isolate only. " +
            "On *.workers.dev every cache put/match is a silent no-op; bind a custom domain.",
        );
      }
    });

  return {
    advance: (spacingMs, now) =>
      Effect.gen(function* () {
        yield* seed();
        // 抢:读和写在同一个同步块里,中间没有让出点 —— 并发 fiber 各拿一个不同的游标。
        const mine = yield* Effect.sync(() => {
          const slot = Math.max(tat, now);
          tat = slot + spacingMs;
          return slot;
        });
        yield* publish(mine + spacingMs, spacingMs, now);
        return mine;
      }),
  };
}
