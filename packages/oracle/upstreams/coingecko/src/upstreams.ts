import type { CoinGeckoConfig } from "@folio/coingecko-client";
import type { Namer } from "@folio/oracle-basic/ports";
import type { FxUpstream, PlatformUpstream, TokenUpstream } from "@folio/upstream-basic/ports";
import type { Layer } from "effect";
import { fxUpstreamOn } from "./fx";
import { coinGeckoNamerLayer, transport } from "./layer";
import { platformUpstreamOn } from "./platform";
import { tokenUpstreamOn } from "./upstream";

/** Mounts all three ports on one `transport(config)` reference so Effect's reference-keyed layer memoisation builds a single client per request. */
export const coinGeckoUpstreamLayers = (
  config: CoinGeckoConfig = {},
): {
  readonly token: Layer.Layer<TokenUpstream>;
  readonly fx: Layer.Layer<FxUpstream>;
  readonly platform: Layer.Layer<PlatformUpstream>;
  readonly namer: Layer.Layer<Namer>;
} => {
  const shared = transport(config);
  return {
    token: tokenUpstreamOn(shared),
    fx: fxUpstreamOn(shared),
    platform: platformUpstreamOn(shared),
    namer: coinGeckoNamerLayer,
  };
};
