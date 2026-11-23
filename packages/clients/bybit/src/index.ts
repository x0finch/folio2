// @folio/bybit-client: request layer for Bybit v5 REST (signing / three account buckets / business-code classification). Talks only to the
// upstream, no folio semantics. Usage: `Effect.provide(BybitClient.layer({ apiBase }))`.
// Two traps handled here: business errors are HTTP 200 + retCode != 0 (a number, unlike OKX's string code), which unchecked would read as
// "balance is 0"; and the signed queryString must match what is sent byte for byte, or only retCode 10004 comes back.
export { BybitClient, type BybitClientApi, type BybitConfig, make } from "./client";
export {
  BYBIT_API_BASE,
  EARN_CATEGORY_FLEXIBLE,
  EARN_CATEGORY_ONCHAIN,
} from "./constants";
export type {
  BybitCoin,
  BybitCreds,
  BybitEarnPosition,
  BybitEarnResponse,
  BybitEnvelope,
  BybitFundingCoin,
  BybitFundingResponse,
  BybitWalletBalanceResponse,
} from "./types";
