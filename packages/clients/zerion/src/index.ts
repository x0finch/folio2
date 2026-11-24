// @folio/zerion-client: request layer for the Zerion API. Talks only to the upstream, no folio semantics (`parsePositions`, `tokenRef`
// naming are in the adapter). Usage: `Effect.provide(ZerionClient.layer())`.
// Two upstream traits live here: HTTP Basic auth (key as username, empty password), and a 24h cache of the slug to chainId mapping.

// Exported for the adapter's golden tests: fixtures are the chain list as is and must become slug to chainId before feeding `parsePositions`.
// Same as `@folio/rabby-client`.
export { parseChainIds } from "./chains";
export { make, ZerionClient, type ZerionClientApi, type ZerionConfig } from "./client";
export { POSITIONS_QUERY, ZERION_API_BASE } from "./constants";
export type {
  ZerionChain,
  ZerionChainsResponse,
  ZerionImplementation,
  ZerionPosition,
  ZerionPositionsResponse,
  ZerionQuantity,
} from "./types";
