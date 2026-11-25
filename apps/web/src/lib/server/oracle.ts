import { env } from "cloudflare:workers";
import { DatabaseForOracle, GlobalDatabase } from "@folio/db";
import { type OracleServices, oracleLayer } from "@folio/oracle";
import { COINGECKO_ID, coinGeckoUpstreamLayers } from "@folio/upstreams";
import { Layer } from "effect";

// Composition point of the reference layer, and the only file that knows both the D1 store
// and the CoinGecko adapter (`@folio/oracle` knows neither). Built once per isolate: no
// connections and no user inside; db ops read the user from context when they run.

// The db layer is vendor-neutral, so the app passes the namer to reads keyed by it.
// Taken from the adapter's constant, not the service: the service would read env at module load.
export const NAMER = COINGECKO_ID;

// One layer per upstream port (fx, platform, token identity): they happen to be one vendor today,
// but the service layer doesn't know that. All come from one `coinGeckoUpstreamLayers`, so one connection.
//
// Safe at isolate level: construction makes only headers and closures; no fiber, timer or I/O handle
// (the `memory` rate-limit tier forks a fiber, production never uses it). `env` is deployment-wide,
// so freezing the key into it can't leak across requests. Cast: the base override and the pro key
// are read by name and aren't in the generated `Env`.
const upstreams = () => {
  const cg = coinGeckoUpstreamLayers(env as unknown as Readonly<Record<string, unknown>>);
  return Layer.mergeAll(cg.token, cg.fx, cg.platform, cg.namer);
};

// `namer` is passed in because the db layer is vendor-neutral and `Namer` would make db consume an oracle service.
const dbForOracle = () => Layer.merge(DatabaseForOracle.layer(COINGECKO_ID), GlobalDatabase.layer);

/** Sealed reference layer: its three domain services plus the userless `GlobalDatabase` (cron needs it to list users). `DatabaseForOracle` is deliberately not exposed to handlers. */
export const oracleServices = (): Layer.Layer<OracleServices | GlobalDatabase> =>
  Layer.provide(oracleLayer, Layer.merge(dbForOracle(), upstreams())).pipe(
    Layer.provideMerge(GlobalDatabase.layer),
  );
