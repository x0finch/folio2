// @folio/oracle: service layer and public facade of the reference layer.
// Knows no upstream: stores and upstreams are Layers injected by the app. Time goes through `Clock`; degradation is `catchAll(UpstreamError)` plus a log line.
// Public surface: per-user `Oracle` (aggregate of `tokens` / `fx` / `platforms`) and the global `GlobalRefIndexService`
// (no userId, not in `oracleLayer`; the `global-` prefix marks "whose", not a module). Domain services are package-internal.
// This package is server-only and does not re-export `@folio/oracle-basic`: its Tags would pull `effect` into client bundles.

export { GlobalRefIndexService } from "./global-ref-index";
export { Oracle, type OraclePorts, type OracleServices, oracleLayer } from "./oracle";
export type { MintInput, RefreshStaleReport } from "./tokens";
