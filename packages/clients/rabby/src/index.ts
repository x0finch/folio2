// @folio/rabby-client: request layer for the Rabby (DeBank backend) API. Talks only to the upstream, no folio semantics. Usage:
// `Effect.provide(RabbyClient.layer())`.
// Three traits live here: no API key but every request must be signed (wasm, see sign.ts), since unsigned is not a 401 but a one-request-per-40s
// rate tier, and the signer is an optional service so plain node tests can replace it; gate limit=1 with no bursts, since it throttles
// instantaneous concurrency and its 429 carries no Retry-After; and a 24h slug to chainId cache (`community_id` is the canonical chainId).
export { make, parseChainIds, RabbyClient, type RabbyClientApi, type RabbyConfig } from "./client";
export { RABBY_API_BASE } from "./constants";
export { RabbySigner, type SignRequest } from "./signer";
export type { RabbyChain, RabbyProtocol, RabbyProtocolItem, RabbyToken } from "./types";
