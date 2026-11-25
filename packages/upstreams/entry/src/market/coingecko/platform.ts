import type { PlatformMeta } from "@folio/oracle-basic";
import type { UpstreamError } from "@folio/upstream-basic";
import { PlatformUpstream } from "@folio/upstream-basic/ports";
import { Effect, Layer } from "effect";
import { assetPlatforms } from "./api";
import { EVM_NAMER_PREFIX, ID } from "./constants";
import { closeOver, type Needs, req, withCall } from "./upstream";

// Each chain yields its slug, plus `evm:<id>` when it has a numeric chainId: balances report either form.
export const fetchChainsEffect: Effect.Effect<PlatformMeta[], UpstreamError, Needs> = withCall(
  (call) =>
    Effect.map(req(assetPlatforms(call)), (list) => {
      const out: PlatformMeta[] = [];
      for (const p of list) {
        if (!p?.id) continue;
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
    id: ID,
    fetchChains: () => close(fetchChainsEffect),
  }),
);

export const platformUpstreamOn = (transport: Layer.Layer<Needs>): Layer.Layer<PlatformUpstream> =>
  Layer.provide(Layer.effect(PlatformUpstream, make), transport);
