import {
  type CoinGeckoConfig,
  CoinGeckoError,
  createCoinGeckoClient,
} from "@folio/coingecko-client";
import { PlatformError, type PlatformMeta, type PlatformSource } from "./types";

interface RawAssetPlatform {
  id?: string;
  chain_identifier?: number | null;
  name?: string;
  image?: { thumb?: string; small?: string; large?: string } | null;
}

// /exchanges/{id} 与 /derivatives/exchanges/{id} 的 image 是直链字符串(与 asset_platforms 不同)。
interface RawVenue {
  name?: string;
  image?: string | null;
}

// venue key → CoinGecko 端点。slug = key 冒号后一段(= 账户 type 的 specific,PRD:无需映射)。
function venuePath(key: string): string | null {
  const slug = key.slice(key.indexOf(":") + 1);
  if (!slug) return null;
  if (key.startsWith("exchange:")) return `/exchanges/${slug}`;
  if (key.startsWith("perp:")) return `/derivatives/exchanges/${slug}`;
  return null;
}

// CoinGecko 的 PlatformSource 实现。链走 /asset_platforms(整表);把 CoinGeckoError → PlatformError。
export function createCoinGeckoPlatformSource(config: CoinGeckoConfig = {}): PlatformSource {
  const client = createCoinGeckoClient(config);
  return {
    async fetchChains() {
      let json: unknown;
      try {
        json = await client.request("/asset_platforms");
      } catch (e) {
        if (e instanceof CoinGeckoError) throw new PlatformError(e.code, e.message, { cause: e });
        throw e;
      }
      if (!Array.isArray(json)) {
        throw new PlatformError("PARSE_ERROR", "asset_platforms: expected array");
      }
      const out: PlatformMeta[] = [];
      for (const p of json as RawAssetPlatform[]) {
        if (!p?.id) continue;
        const name = p.name?.trim() || p.id;
        const logo = p.image?.small ?? p.image?.thumb ?? undefined;
        // 每条链产 chain:<slug>;有数字 chainId 再产 eip155:<id>(两种 platformKey 都覆盖)。
        out.push({ key: `chain:${p.id.toLowerCase()}`, name, logo });
        if (p.chain_identifier != null && Number.isFinite(p.chain_identifier)) {
          out.push({ key: `eip155:${p.chain_identifier}`, name, logo });
        }
      }
      return out;
    },

    async fetchVenue(key) {
      const path = venuePath(key);
      if (!path) return null;
      let json: unknown;
      try {
        json = await client.request(path, undefined, { notFoundAsNull: true });
      } catch (e) {
        if (e instanceof CoinGeckoError) throw new PlatformError(e.code, e.message, { cause: e });
        throw e;
      }
      if (json == null) return null; // 404 未收录
      const raw = json as RawVenue;
      const name = raw.name?.trim();
      if (!name) return null;
      const logo = raw.image?.trim() || undefined;
      return { key, name, logo };
    },
  };
}
