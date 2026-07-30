import { type CoinGeckoConfig, createCoinGeckoClient } from "@folio/coingecko-client";
import type { PlatformMeta, PlatformUpstream } from "@folio/oracle-basic";
import { EVM_NAMER_PREFIX, UPSTREAM_ID } from "./constants";

// `PlatformUpstream` 的 CoinGecko 实现:一次 `/asset_platforms` 拿整张链表。
//
// **一条链产两个键**:短形 slug(`solana`),以及有数字 chainId 时再产一条 `evm:<id>`。
// 两种 platformKey 都可能出现在余额行上(链上 provider 报 `evm:1`,比特币那类报 slug),
// 与其让服务层去猜哪种,不如两条都产 —— 反正是同一份名与图。
export function createCoinGeckoPlatformUpstream(config: CoinGeckoConfig = {}): PlatformUpstream {
  const client = createCoinGeckoClient(config);
  return {
    id: UPSTREAM_ID,

    async fetchChains() {
      const out: PlatformMeta[] = [];
      for (const p of await client.assetPlatforms()) {
        if (!p?.id) continue;
        // 上游没给名字就用它的 id —— 比留空强,而且服务层的兜底名也推不出更好的。
        const name = p.name?.trim() || p.id;
        const logo = p.image?.small ?? p.image?.thumb ?? undefined;
        out.push({ key: p.id.toLowerCase(), name, logo });
        if (p.chain_identifier != null && Number.isFinite(p.chain_identifier)) {
          out.push({ key: `${EVM_NAMER_PREFIX}${p.chain_identifier}`, name, logo });
        }
      }
      return out;
    },
  };
}
