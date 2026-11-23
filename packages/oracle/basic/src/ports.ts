import { Context } from "effect";
import type * as Upstreams from "./upstream";

// Tags (Effect service identifiers) for the outbound ports; the contract types are in `upstream.ts`.
// Local persistence is not a port: the contract is the `@folio/db` implementation, reached through its three tickets
// (`Database` / `DatabaseForOracle` / `GlobalDatabase`). The remaining ports are real: which upstream serves egress is one line at the
// assembly point and the service layer must not know it; swapping vendors means swapping a layer.
// Separate entry (`@folio/oracle-basic/ports`) because `Context.GenericTag(...)` is a runtime value and the main entry is value-imported
// by client components; merging would put `effect` (+75 KB gzip) in the client bundle's reachable graph.
// Named like `@effect/platform` (`FileSystem` / `HttpClient`): interface and Tag share one name, so `yield* TokenUpstream` is a `TokenUpstream`.

// The token upstream's three faces: one Tag, not three, since one vendor always implements all of them (shared catalogue and ids).
export type TokenUpstream = Upstreams.TokenUpstream;
export const TokenUpstream = Context.GenericTag<TokenUpstream>("oracle/TokenUpstream");

// Naming identity (id + curated table): a separate Tag from `TokenUpstream`, since the write path needs only this, not the network faces.
export type Namer = Upstreams.Namer;
export const Namer = Context.GenericTag<Namer>("oracle/Namer");

// Fx and platforms are independent of "which token is this" and may come from another vendor.
export type FxUpstream = Upstreams.FxUpstream;
export const FxUpstream = Context.GenericTag<FxUpstream>("oracle/FxUpstream");

export type PlatformUpstream = Upstreams.PlatformUpstream;
export const PlatformUpstream = Context.GenericTag<PlatformUpstream>("oracle/PlatformUpstream");
