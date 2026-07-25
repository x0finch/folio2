import type {
  PlatformMeta,
  PlatformRow,
  PlatformSource,
  PlatformStore,
  Platforms,
} from "@folio/oracle-basic";

// 平台元数据近乎静态 → 长 TTL;venue 404(未收录)用短 TTL,新上所日后可补。
const CHAIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VENUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VENUE_NEG_TTL_MS = 24 * 60 * 60 * 1000;

// 平台键(ADR 0020 起链键用短形,与 tokenRef 的命名者同形):场馆键带前缀 `exchange:`/`perp:`,
// 链键不带(`evm:<id>` / `<slug>`)→ 非场馆即链。
const isVenueKey = (k: string): boolean => k.startsWith("exchange:") || k.startsWith("perp:");
const isChainKey = (k: string): boolean => !isVenueKey(k);

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// 未收录/未预热/否定缓存平台的兜底展示名(纯由 key 推)。
// evm:<id> 无 slug → 用原 key;其余取冒号后一段首字母大写(manual → "Manual")。
// 平台的"显示成什么"整个归本模块所有(见 ADR 0005/0006 收口);aggregate 只发 key。
function fallbackName(key: string): string {
  if (key.startsWith("evm:")) return key;
  const slug = key.slice(key.indexOf(":") + 1);
  return cap(slug || key);
}

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
    // 读:每个 key 都给一份展示(展示用,零网络)。命中且非否定缓存 → 用缓存 name+logo;
    // 未命中/否定缓存 → 兜底名(slug-cap)。平台展示的唯一出口,调用方直接用,不再自算兜底。
    async resolve(keys) {
      const unique = [...new Set(keys)];
      const out = new Map<string, PlatformMeta>();
      if (unique.length === 0) return out;
      const rows = await store.getPlatforms(unique);
      for (const key of unique) {
        const r = rows.get(key);
        out.set(
          key,
          r?.name != null
            ? { key, name: r.name, logo: r.logo ?? undefined }
            : { key, name: fallbackName(key) },
        );
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
