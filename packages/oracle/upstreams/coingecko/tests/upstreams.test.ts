import { runClient } from "@folio/client-core/testing";
import { CoinGeckoClient, type CoinGeckoConfig } from "@folio/coingecko-client";
import { FxUpstream, Namer, PlatformUpstream, TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coinGeckoUpstreamLayers } from "../src/upstreams";
import { routed } from "./harness";

// Mounting all three ports builds one client per construction: layer memoisation is keyed by reference, and
// building a client is not free, so this counts how many times the client is actually built.

// Counts each time the layer is actually built.
const countBuilds = () => {
  const real = CoinGeckoClient.layer;
  const counter = { builds: 0 };
  vi.spyOn(CoinGeckoClient, "layer").mockImplementation((config?: CoinGeckoConfig) =>
    Layer.tap(real(config), () =>
      Effect.sync(() => {
        counter.builds += 1;
      }),
    ),
  );
  return counter;
};

// Resolve all four tickets: success proves the graph built and each slot is wired to the right port.
const idsFrom = (layer: Layer.Layer<TokenUpstream | FxUpstream | PlatformUpstream | Namer>) =>
  runClient(
    routed({}).http,
    Effect.all([TokenUpstream, FxUpstream, PlatformUpstream, Namer]).pipe(
      Effect.map((ports) => ports.map((p) => p.id)),
      Effect.provide(layer),
    ),
    "none",
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("coinGeckoUpstreamLayers", () => {
  it("three ports share one client: one build per construction", async () => {
    const counter = countBuilds();
    const cg = coinGeckoUpstreamLayers({ apiKey: "k" });

    const ids = await idsFrom(Layer.mergeAll(cg.token, cg.fx, cg.platform, cg.namer));

    expect(ids).toEqual(["coingecko", "coingecko", "coingecko", "coingecko"]);
    expect(counter.builds).toBe(1);
  });

  // Control: memoisation is keyed by reference, not config, so two calls with identical config still build twice.
  it("control: two calls with identical config still build separately", async () => {
    const counter = countBuilds();
    const config = { apiKey: "k" };
    const a = coinGeckoUpstreamLayers(config);
    const b = coinGeckoUpstreamLayers(config);

    await idsFrom(Layer.mergeAll(a.token, b.fx, b.platform, a.namer));

    expect(counter.builds).toBe(2);
  });
});
