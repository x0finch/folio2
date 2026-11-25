import type { RefIndexFetch } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { AssetPlatform, CoinListItem } from "./api";
import { NON_EVM_PLATFORMS } from "./constants";
import { cgkRef } from "./parse";

// Flattens CoinGecko's two endpoints into global ref-index rows. Pure and zero IO: a wrong row means a
// whole chain's tokens lose price and logo with no error, so it is pinned by fixtures.

// CoinGecko asset_platform id to our namer.
function namerByPlatformId(platforms: readonly AssetPlatform[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of platforms) {
    if (!p?.id) continue;
    // EVM: both sides map to `evm:<chainId>` by number.
    if (p.chain_identifier != null && Number.isFinite(p.chain_identifier)) {
      out.set(p.id, `evm:${p.chain_identifier}`);
    }
  }
  // Non-EVM: explicit table (our namer to its id), written over; the table wins.
  for (const [namer, platformId] of Object.entries(NON_EVM_PLATFORMS)) {
    out.set(platformId, namer);
  }
  return out;
}

export function toRefIndexRows(
  coins: readonly CoinListItem[],
  platforms: readonly AssetPlatform[],
): RefIndexFetch {
  const namerOf = namerByPlatformId(platforms);

  // Check that the non-EVM chains we ask for still exist in CoinGecko's platform list.
  const known = new Set(platforms.map((p) => p?.id).filter((id): id is string => !!id));
  const unmatchedPlatforms = Object.entries(NON_EVM_PLATFORMS)
    .filter(([, platformId]) => !known.has(platformId))
    .map(([namer]) => namer);

  const rows: RefIndexFetch["rows"] = [];
  let skipped = 0;
  for (const coin of coins) {
    const coinId = coin?.id;
    if (!coinId || !coin.platforms) continue;
    for (const [platformId, address] of Object.entries(coin.platforms)) {
      // Native coins have an empty address here; no row, they are matched by symbol.
      const addr = address?.trim();
      if (!platformId || !addr) continue;
      const namer = namerOf.get(platformId);
      if (!namer) {
        skipped += 1;
        continue;
      }
      // chainRef is an on-chain `contract:` ref (lets mint's symbol gate skip it); EVM address normalisation is the grammar's job.
      // upstreamRef is the whole upstream name (`coingecko/issued:<id>`), never a bare id.
      rows.push({ chainRef: tokenRef.contract(namer, addr), upstreamRef: cgkRef(coinId) });
    }
  }
  return { rows, unmatchedPlatforms, skipped };
}
