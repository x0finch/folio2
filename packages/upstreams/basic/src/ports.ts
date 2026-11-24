import { Context } from "effect";
import type * as Market from "./market";

// Tags for the market ports; contracts are in `market.ts`. Separate entry (`@folio/upstream-basic/ports`) so the contract types can be
// imported without pulling a runtime value. Interface and Tag share one name, so `yield* TokenUpstream` is a `TokenUpstream`.

// The token upstream's three faces: one Tag, not three, since one vendor always implements all of them (shared catalogue and ids).
export type TokenUpstream = Market.TokenUpstream;
export const TokenUpstream = Context.Service<TokenUpstream>("upstream/TokenUpstream");

// Fx and platforms are independent of "which token is this" and may come from another vendor.
export type FxUpstream = Market.FxUpstream;
export const FxUpstream = Context.Service<FxUpstream>("upstream/FxUpstream");

export type PlatformUpstream = Market.PlatformUpstream;
export const PlatformUpstream = Context.Service<PlatformUpstream>("upstream/PlatformUpstream");
