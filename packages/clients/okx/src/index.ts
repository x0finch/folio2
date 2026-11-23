// @folio/okx-client: request layer for OKX v5 REST (signing / six endpoints / business-code classification). Talks only to the upstream,
// no folio semantics. Usage: `Effect.provide(OkxClient.layer({ apiBase }))`.
// Three differences from other upstreams, all handled here: the requestPath in the signing string includes the query and the timestamp is an
// ISO string; credentials include a passphrase; business errors are HTTP 200 + code != "0" with a string code.
export { make, OkxClient, type OkxClientApi, type OkxConfig } from "./client";
export { OKX_API_BASE } from "./constants";
export type {
  OkxBalanceResponse,
  OkxCreds,
  OkxDetail,
  OkxEnvelope,
  OkxFundingAsset,
  OkxFundingResponse,
  OkxPositionsResponse,
  OkxSavingsResponse,
  OkxSavingsRow,
  OkxStakingInvest,
  OkxStakingOrder,
  OkxStakingResponse,
  OkxValuationDetails,
  OkxValuationResponse,
} from "./types";
