import type { CacheStore, PlatformMeta, PlatformUpstream } from "@folio/oracle2-basic";
import { readPlatform, writePlatform } from "./cache";

// 平台的名与图。与汇率同款两个动词、同款判据:`resolve` 读(零网络、软过期),`warm` 写(过期才拉)。
//
// **「一个平台显示成什么」整个归本模块所有**(ADR 0005/0006 的收口):没缓存、上游没收录、
// 缓存过期 —— 三种情况调用方都不需要区分,`resolve` 一律给一个能上屏的名字。
export interface Platforms {
  // 每个 key 都给一份展示。命中真名就用真名,否则按 key 推一个兜底名。**不出网。**
  resolve(keys: readonly string[]): Promise<Map<string, PlatformMeta>>;
  // 同步后预热:这些 key 里有缺的或过期的 → 拉一次整张链表 → **只写这几个 key**。
  warm(keys: readonly string[]): Promise<void>;
}

export interface PlatformsDeps {
  cache: CacheStore;
  upstream: PlatformUpstream;
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// 未收录 / 未预热的平台的兜底展示名(纯由 key 推)。
// `evm:<id>` 没有 slug 可用 → 原样显示;其余取冒号后一段首字母大写(`manual` → "Manual")。
function fallbackName(key: string): string {
  if (key.startsWith("evm:")) return key;
  const slug = key.slice(key.indexOf(":") + 1);
  return cap(slug || key);
}

export function createPlatforms({ cache, upstream }: PlatformsDeps): Platforms {
  return {
    async resolve(keys) {
      const unique = [...new Set(keys)];
      const out = new Map<string, PlatformMeta>();
      if (unique.length === 0) return out;

      const hits = await Promise.all(unique.map((k) => readPlatform(cache, k)));
      unique.forEach((key, i) => {
        const entry = hits[i]?.entry;
        // `name === null`(否定缓存)与没缓存走同一条兜底路 —— 对展示来说是同一件事。
        out.set(
          key,
          entry?.name != null
            ? { key, name: entry.name, logo: entry.logo }
            : { key, name: fallbackName(key) },
        );
      });
      return out;
    },

    async warm(keys) {
      const unique = [...new Set(keys)];
      if (unique.length === 0) return;

      const hits = await Promise.all(unique.map((k) => readPlatform(cache, k)));
      const missing = unique.filter((_, i) => hits[i] === undefined || hits[i].stale);
      if (missing.length === 0) return;

      // 一次拉全 —— 上游那个端点本来就是整张表,按 key 单查这回事在它那儿不存在。
      const byKey = new Map((await upstream.fetchChains()).map((c) => [c.key, c]));

      // **只写我们被问到的那几个键**,不是整张两百行的表:这张缓存是 per-user 的,
      // 把所有链都塞进每个用户的缓存里毫无意义 —— 他持仓就在那么几条链上。
      // 表里没有的写否定缓存(短 TTL),否则这个键会让此后每一次预热都重拉整张表。
      await Promise.all(
        missing.map((key) => {
          const hit = byKey.get(key);
          return writePlatform(
            cache,
            key,
            hit ? { name: hit.name, logo: hit.logo } : { name: null },
          );
        }),
      );
    },
  };
}
