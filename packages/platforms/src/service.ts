import type { PlatformMeta, PlatformRow, PlatformSource, PlatformStore, Platforms } from "./types";

// 平台元数据近乎静态 → 长 TTL;venue 404(未收录)用短 TTL,新上所日后可补。
const CHAIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VENUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VENUE_NEG_TTL_MS = 24 * 60 * 60 * 1000;

const isChainKey = (k: string): boolean => k.startsWith("eip155:") || k.startsWith("chain:");
const isVenueKey = (k: string): boolean => k.startsWith("exchange:") || k.startsWith("perp:");

export interface CreatePlatformsConfig {
  source: PlatformSource;
  store: PlatformStore;
  now?: () => number;
}

export function createPlatforms({
  source,
  store,
  now = Date.now,
}: CreatePlatformsConfig): Platforms {
  return {
    // 读:只读缓存(展示用),零网络;否定缓存(name=null)不返回。
    async resolve(keys) {
      const unique = [...new Set(keys)];
      if (unique.length === 0) return new Map();
      const rows = await store.getPlatforms(unique);
      const out = new Map<string, PlatformMeta>();
      for (const [key, r] of rows) {
        if (r.name != null) out.set(key, { key, name: r.name, logo: r.logo ?? undefined });
      }
      return out;
    },

    // 写:sync 后预热。链一次取整表缓存;venue 按 key 单查(404 → 短 TTL 否定缓存)。
    async warm(keys) {
      const unique = [...new Set(keys)];
      const cached = await store.getPlatforms(unique.filter((k) => isChainKey(k) || isVenueKey(k)));
      const isStale = (k: string): boolean => {
        const r = cached.get(k);
        return !r || r.expiresAt <= now();
      };
      const writes: PlatformRow[] = [];

      // 链:任一 key 过期 → 取整表(一次覆盖所有链)。
      const chainKeys = unique.filter(isChainKey);
      if (chainKeys.some(isStale)) {
        const chains = await source.fetchChains();
        const expiresAt = now() + CHAIN_TTL_MS;
        for (const c of chains) {
          writes.push({ key: c.key, name: c.name, logo: c.logo ?? null, expiresAt });
        }
      }

      // venue:逐个单查(命中长 TTL;404 → name=null 短 TTL 否定缓存)。
      for (const k of unique.filter(isVenueKey)) {
        if (!isStale(k)) continue;
        const meta = await source.fetchVenue(k);
        writes.push(
          meta
            ? { key: k, name: meta.name, logo: meta.logo ?? null, expiresAt: now() + VENUE_TTL_MS }
            : { key: k, name: null, logo: null, expiresAt: now() + VENUE_NEG_TTL_MS },
        );
      }

      if (writes.length > 0) await store.putPlatforms(writes);
    },
  };
}
