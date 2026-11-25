import { Namer } from "@folio/oracle-basic/ports";
import type { FxUpstream, PlatformUpstream, TokenUpstream } from "@folio/upstream-basic/ports";
import { Layer } from "effect";
import { ID, OVERRIDES } from "./constants";
import { fxUpstreamOn } from "./fx";
import { platformUpstreamOn } from "./platform";
import { tokenUpstreamOn } from "./token";
import { transport } from "./upstream";

const namer: Layer.Layer<Namer> = Layer.succeed(Namer, { id: ID, overrides: OVERRIDES });

// The ports share one `transport` reference: layer memoisation is by reference, so a request
// connects once.
export const coinGeckoUpstreamLayers = (
  env: Readonly<Record<string, unknown>>,
): {
  readonly token: Layer.Layer<TokenUpstream>;
  readonly fx: Layer.Layer<FxUpstream>;
  readonly platform: Layer.Layer<PlatformUpstream>;
  readonly namer: Layer.Layer<Namer>;
} => {
  const shared = transport(env);
  return {
    token: tokenUpstreamOn(shared),
    fx: fxUpstreamOn(shared),
    platform: platformUpstreamOn(shared),
    namer,
  };
};
