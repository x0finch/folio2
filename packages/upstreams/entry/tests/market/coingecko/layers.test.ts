import { Namer } from "@folio/oracle-basic/ports";
import { FxUpstream, PlatformUpstream, TokenUpstream } from "@folio/upstream-basic/ports";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coinGeckoUpstreamLayers } from "../../../src/market/coingecko/layers";
import { coingecko } from "../../../src/market/coingecko/upstream";
import { runClient } from "../../../src/runtime/testing";
import { routed } from "./harness";

const countConnects = () => vi.spyOn(coingecko, "connect");

// Resolving all four proves the graph builds and each slot holds the right port.
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
  it("three ports share one connection per construction", async () => {
    const connects = countConnects();
    const cg = coinGeckoUpstreamLayers({ COINGECKO_API_KEY: "k" });

    const ids = await idsFrom(Layer.mergeAll(cg.token, cg.fx, cg.platform, cg.namer));

    expect(ids).toEqual(["coingecko", "coingecko", "coingecko", "coingecko"]);
    expect(connects).toHaveBeenCalledTimes(1);
  });

  // Control: memoisation is by reference, not env, so two constructions connect twice.
  it("control: two constructions with the same env connect separately", async () => {
    const connects = countConnects();
    const env = { COINGECKO_API_KEY: "k" };
    const a = coinGeckoUpstreamLayers(env);
    const b = coinGeckoUpstreamLayers(env);

    await idsFrom(Layer.mergeAll(a.token, b.fx, b.platform, a.namer));

    expect(connects).toHaveBeenCalledTimes(2);
  });
});
