import type { PlatformMeta, PlatformSource, PlatformStore, Platforms } from "./types";

// 平台元数据近乎静态 → 长 TTL。
const CHAIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const isChainKey = (k: string): boolean => k.startsWith("eip155:") || k.startsWith("chain:");

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

    // 写:sync 后预热。链一次取整表缓存(命中且未过期则跳过);venue 见 #03。
    async warm(keys) {
      const chainKeys = [...new Set(keys)].filter(isChainKey);
      if (chainKeys.length === 0) return;
      const cached = await store.getPlatforms(chainKeys);
      const stale = chainKeys.some((k) => {
        const r = cached.get(k);
        return !r || r.expiresAt <= now();
      });
      if (!stale) return;
      const chains = await source.fetchChains();
      const expiresAt = now() + CHAIN_TTL_MS;
      await store.putPlatforms(
        chains.map((c) => ({ key: c.key, name: c.name, logo: c.logo ?? null, expiresAt })),
      );
    },
  };
}
