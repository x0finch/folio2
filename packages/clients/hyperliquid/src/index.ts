// @folio/hyperliquid-client: request layer for Hyperliquid REST. Talks only to the upstream, no folio semantics (parsing, perp valuation
// model, `tokenRef` naming and address validation are in the adapter). Usage: `Effect.provide(HyperliquidClient.layer())`.
// Read-only by address: no signature, no key, no gate (quota is per IP and ample, see constants.ts).
export {
  HyperliquidClient,
  type HyperliquidClientApi,
  type HyperliquidConfig,
  make,
} from "./client";
export { HYPERLIQUID_API_BASE } from "./constants";
export type { ClearinghouseState, HlLeverage, HlMarginSummary, HlPosition } from "./types";
