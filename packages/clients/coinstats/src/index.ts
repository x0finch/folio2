// @folio/coinstats-client: request layer for the CoinStats OpenAPI. Talks only to the upstream, no folio semantics (`parseBalances`, `tokenRef`
// naming, the connectionId fallback rule and the per-chain connector manifests are in the adapter). Usage: `Effect.provide(CoinstatsClient.layer())`.
// One key serves three chains (solana / sui / cosmos), so the gate must be cross-isolate (see constants.ts); apiKey and connectionId are passed
// per call, so one client serves all chains and accounts.
export { CoinstatsClient, type CoinstatsClientApi, type CoinstatsConfig, make } from "./client";
export { COINSTATS_API_BASE } from "./constants";
export type { CoinstatsCoin } from "./types";
