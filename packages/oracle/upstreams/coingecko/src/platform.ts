import type { CoinGeckoClient } from "@folio/coingecko-client";
import type { PlatformMeta } from "@folio/oracle-basic";
import type { UpstreamError } from "@folio/upstream-basic";
import { PlatformUpstream } from "@folio/upstream-basic/ports";
import type { Outbound } from "@folio/upstreams";
import { Effect, Layer } from "effect";
import { EVM_NAMER_PREFIX, UPSTREAM_ID } from "./constants";
import { closeOver, type Needs } from "./layer";
import { req, withClient } from "./runtime";

// CoinGecko `PlatformUpstream`: one `/asset_platforms` call yields the whole chain table.
// Each chain yields two keys (slug, plus `evm:<id>` when a numeric chainId exists) since balances report either form.
export const fetchChainsEffect: Effect.Effect<
  PlatformMeta[],
  UpstreamError,
  CoinGeckoClient | Outbound
> = withClient((client) =>
  Effect.map(req(client.assetPlatforms), (list) => {
    const out: PlatformMeta[] = [];
    for (const p of list) {
      if (!p?.id) continue;
      // Falls back to the id when upstream gives no name.
      const name = p.name?.trim() || p.id;
      const logo = p.image?.small ?? p.image?.thumb ?? undefined;
      out.push({ key: p.id.toLowerCase(), name, logo });
      if (p.chain_identifier != null && Number.isFinite(p.chain_identifier)) {
        out.push({ key: `${EVM_NAMER_PREFIX}${p.chain_identifier}`, name, logo });
      }
    }
    return out;
  }),
);

const make = Effect.map(
  closeOver,
  (close): PlatformUpstream => ({
    id: UPSTREAM_ID,
    fetchChains: () => close(fetchChainsEffect),
  }),
);

/** Mounted on a given transport; the only export path is `coinGeckoUpstreamLayers`. */
export const platformUpstreamOn = (t: Layer.Layer<Needs>): Layer.Layer<PlatformUpstream> =>
  Layer.provide(Layer.effect(PlatformUpstream, make), t);
