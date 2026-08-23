import type { PlatformMeta } from "@folio/oracle-basic";
import { PLATFORM_NEG_TTL_MS, PLATFORM_TTL_MS } from "@folio/oracle-basic";
import { CacheStore, PlatformUpstream } from "@folio/oracle-basic/ports";
import { Effect, Option, Schema } from "effect";
import { degradeTo } from "./tokens/swr";

// 平台(链 ∪ 场馆)的名与图。与汇率同款两个动词、同款判据:`resolve` 读(零网络、软过期),
// `warm` 写(过期才拉)。
//
// **「一个平台显示成什么」整个归本模块所有**(ADR 0005/0006 的收口):没缓存、上游没收录、
// 缓存过期 —— 三种情况调用方都不需要区分,`resolve` 一律给一个能上屏的名字。
//
// 读写都走缓存的**批量**那两个口:一个用户的链就那么几条,但展示时每条都要,逐键点查等于
// 把总览的一次 D1 往返变成 N 次(见 `CacheStore` 的注释)。
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// 未收录 / 未预热的平台的兜底展示名(纯由 key 推)。
// `evm:<id>` 没有 slug 可用 → 原样显示;其余取冒号后一段首字母大写(`manual` → "Manual")。
function fallbackName(key: string): string {
  if (key.startsWith("evm:")) return key;
  const slug = key.slice(key.indexOf(":") + 1);
  return cap(slug || key);
}

// —— 缓存那一侧:键、形状、两个读写口 ——
// 平台住 per-user 缓存表的 `platform:<键>` 键上(另两种键见 warm.ts / fx.ts)。

export const platformKey = (key: string): string => `platform:${key}`;

// **`name: null` = 否定缓存** —— 问过上游、它的链表里没有这个键。与「这条压根没有」必须分开:
// 后者会让每一次预热都为了这一个键重拉整张链表。
// 形状走 Schema **解码**不是 `as` 断言:解不动(旧形状 / 手改过库)当 miss,回源重写一份,自愈。
const PlatformEntryShape = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  logo: Schema.optional(Schema.String),
});
export type PlatformEntry = Schema.Schema.Type<typeof PlatformEntryShape>;
const decodePlatform = Schema.decodeUnknownOption(PlatformEntryShape);

// 读一批。**返回 `{name: null}` 与「键不在结果里」是两件事**:前者是「问过、上游没有」,
// 后者是「没问过」。`stale` 一并给出来 —— 预热据它决定要不要重拉,展示则一律用旧的。
export const readPlatforms = (
  cache: CacheStore,
  keys: readonly string[],
): Effect.Effect<Map<string, { entry: PlatformEntry; stale: boolean }>> =>
  Effect.map(cache.getMany(keys.map(platformKey)), (hits) => {
    const out = new Map<string, { entry: PlatformEntry; stale: boolean }>();
    for (const key of keys) {
      const hit = hits.get(platformKey(key));
      if (!hit) continue;
      const entry = decodePlatform(hit.value);
      if (Option.isNone(entry)) continue;
      out.set(key, { entry: entry.value, stale: hit.stale });
    }
    return out;
  });

// 一次批量写。命中写长 TTL(名与图近静态),否定写短 TTL(新链随时可能被收录)。
export const writePlatforms = (
  cache: CacheStore,
  entries: readonly { key: string; entry: PlatformEntry }[],
): Effect.Effect<void> =>
  cache.putMany(
    entries.map(({ key, entry }) => ({
      key: platformKey(key),
      value: entry,
      ttlMs: entry.name === null ? PLATFORM_NEG_TTL_MS : PLATFORM_TTL_MS,
    })),
  );

// 服务的形状从下面这段 `effect` 的返回值推导,`.Default` 就是它的 layer —— 不再手写
// interface + Tag + layer 三件套(#501)。
export class PlatformService extends Effect.Service<PlatformService>()("oracle/PlatformService", {
  effect: Effect.gen(function* () {
    const cache = yield* CacheStore;
    const upstream = yield* PlatformUpstream;

    return {
      // 每个 key 都给一份展示。命中真名就用真名,否则按 key 推一个兜底名。**不出网、一次读。**
      resolve: (keys: readonly string[]): Effect.Effect<Map<string, PlatformMeta>> =>
        Effect.gen(function* () {
          const unique = [...new Set(keys)];
          const out = new Map<string, PlatformMeta>();
          if (unique.length === 0) return out;

          const hits = yield* readPlatforms(cache, unique); // 一次读
          for (const key of unique) {
            const entry = hits.get(key)?.entry;
            // `name === null`(否定缓存)与没缓存走同一条兜底路 —— 对展示来说是同一件事。
            out.set(
              key,
              entry?.name != null
                ? { key, name: entry.name, logo: entry.logo }
                : { key, name: fallbackName(key) },
            );
          }
          return out;
        }),

      // 同步后预热:这些 key 里有缺的或过期的 → 拉一次整张链表 → **一个批次写回这几个 key**。
      warm: (keys: readonly string[]): Effect.Effect<void> =>
        Effect.gen(function* () {
          const unique = [...new Set(keys)];
          if (unique.length === 0) return;

          const hits = yield* readPlatforms(cache, unique);
          const missing = unique.filter((k) => {
            const hit = hits.get(k);
            return hit === undefined || hit.stale;
          });
          if (missing.length === 0) return;

          // 一次拉全 —— 上游那个端点本来就是整张表,按 key 单查这回事在它那儿不存在。
          //
          // 降级到 **`none` 而不是空表**:这两件事在这里不一样 —— 「上游说它没有这条链」要写否定
          // 缓存(短 TTL,免得每次预热都重拉整张表),而「上游挂了」**绝不能**写:那会把一条真实
          // 存在的链按「不存在」记上一天。给 `[]` 就把两者抹平了。
          const chains = yield* upstream
            .fetchChains()
            .pipe(
              Effect.map(Option.some<readonly PlatformMeta[]>),
              degradeTo("platforms.warm", Option.none<readonly PlatformMeta[]>()),
            );
          if (Option.isNone(chains)) return;
          const byKey = new Map(chains.value.map((c) => [c.key, c]));

          // **只写我们被问到的那几个键**,不是整张两百行的表:这张缓存是 per-user 的,
          // 把所有链都塞进每个用户的缓存里毫无意义 —— 他持仓就在那么几条链上。
          // 表里没有的写否定缓存(短 TTL),否则这个键会让此后每一次预热都重拉整张表。
          yield* writePlatforms(
            cache,
            missing.map((key) => {
              const hit = byKey.get(key);
              return { key, entry: hit ? { name: hit.name, logo: hit.logo } : { name: null } };
            }),
          );
        }),
    };
  }),
}) {}
