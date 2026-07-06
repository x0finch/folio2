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
  };
}
