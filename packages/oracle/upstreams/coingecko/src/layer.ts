import { CoinGeckoClient, type CoinGeckoConfig } from "@folio/coingecko-client";
import { Namer } from "@folio/oracle-basic/ports";
import type { UpstreamError } from "@folio/upstream-basic";
import { FolioHttpClient, type Outbound } from "@folio/upstreams";
import { Effect, Layer } from "effect";
import { OVERRIDES, UPSTREAM_ID } from "./constants";

// Shared by the three port layers.
// The transport is closed here: port signatures are `Effect<A, UpstreamError>` (`R = never`), so the client and
// `HttpClient` are provided by this package and no `Outbound` leaks into the reference layer.
// Method bodies capture the context at build time and `Effect.provide` it on exit, so the implementation
// stays plain Effect (tests provide a fake `HttpClient`) while the port side stays clean.
// The rate-limit cursor lives at module level keyed by key (survives across requests on Workers), so
// however many clients are built, they share one gate.
export type Needs = CoinGeckoClient | Outbound;

export const transport = (config: CoinGeckoConfig): Layer.Layer<Needs> =>
  Layer.merge(CoinGeckoClient.layer(config), FolioHttpClient);

// Capture context once; returns a function that narrows implementation effects to port shape.
export const closeOver: Effect.Effect<
  <A>(effect: Effect.Effect<A, UpstreamError, Needs>) => Effect.Effect<A, UpstreamError>,
  never,
  Needs
> = Effect.map(
  Effect.context<Needs>(),
  (ctx) =>
    <A>(effect: Effect.Effect<A, UpstreamError, Needs>): Effect.Effect<A, UpstreamError> =>
      Effect.provide(effect, ctx),
);

// Naming identity (id + curated overrides); needs no client or config.
export const coinGeckoNamerLayer: Layer.Layer<Namer> = Layer.succeed(Namer, {
  id: UPSTREAM_ID,
  overrides: OVERRIDES,
});
