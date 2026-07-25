import {
  type CoinGeckoConfig,
  CoinGeckoError,
  createCoinGeckoClient,
  type DerivativesExchange,
  type Exchange,
} from "@folio/coingecko-client";
import { PlatformError, type PlatformMeta, type PlatformSource } from "@folio/oracle-basic";

// CoinGecko 的 PlatformSource 实现。链走 assetPlatforms(整表),场馆按 key 前缀走 exchange/derivativesExchange;
// slug = key 冒号后一段(= 账户 type 的 specific,PRD:无需映射)。把 CoinGeckoError → PlatformError。
export function createCoinGeckoPlatformSource(config: CoinGeckoConfig = {}): PlatformSource {
  const client = createCoinGeckoClient(config);

  const mapErr = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof CoinGeckoError) throw new PlatformError(e.code, e.message, { cause: e });
      throw e;
    }
  };

  return {
    async fetchChains() {
      const platforms = await mapErr(client.assetPlatforms());
      const out: PlatformMeta[] = [];
      for (const p of platforms) {
        if (!p?.id) continue;
        const name = p.name?.trim() || p.id;
        const logo = p.image?.small ?? p.image?.thumb ?? undefined;
        // 每条链产短形 slug;有数字 chainId 再产 evm:<id>(两种 platformKey 都覆盖)。
        out.push({ key: p.id.toLowerCase(), name, logo });
        if (p.chain_identifier != null && Number.isFinite(p.chain_identifier)) {
          out.push({ key: `evm:${p.chain_identifier}`, name, logo });
        }
      }
      return out;
    },

    async fetchVenue(key) {
      const slug = key.slice(key.indexOf(":") + 1);
      if (!slug) return null;

      let venue: Exchange | DerivativesExchange | null;
      if (key.startsWith("exchange:")) venue = await mapErr(client.exchange(slug));
      else if (key.startsWith("perp:")) venue = await mapErr(client.derivativesExchange(slug));
      else return null;

      if (!venue) return null; // 404 未收录
      const name = venue.name?.trim();
      if (!name) return null;
      const logo = venue.image?.trim() || undefined;
      return { key, name, logo };
    },
  };
}
