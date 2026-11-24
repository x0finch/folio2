import type { SigningFailure } from "@folio/client-core";
import { Context, Effect, Option } from "effect";

export type SignRequest = (
  method: string,
  path: string,
  params: Record<string, unknown>,
) => Effect.Effect<Record<string, string>, SigningFailure>;

// The signer: an optional service read with `Effect.serviceOption`, so the `R` channel stays clean (same scheme as `Fetcher` / `SlotCacheOverride`).
// Why a service rather than a direct call: `./sign` imports `../vendor/rabby_sign.wasm` at top level, which only resolves in the Workers runtime /
// build chain, so a plain node import blows up. As an optional service, production provides none and takes the dynamic import below,
// while tests provide a fake, so the signing wiring (is params the copy that was sent, are all headers present) is pinned in ordinary tests.
export class RabbySigner extends Context.Service<RabbySigner, SignRequest>()(
  "clients/RabbySigner",
) {}

// When none is provided: load the real one on demand.
// Dynamic import, never hoisted to top level: besides the `.wasm` reason above, it keeps wasm instantiation off the Worker's startup path. The module system caches it.
const realSigner: SignRequest = (method, path, params) =>
  Effect.flatMap(
    Effect.promise(() => import("./sign")),
    (mod) => mod.signRabbyRequest(method, path, params),
  );

export const currentSigner: Effect.Effect<SignRequest> = Effect.map(
  Effect.serviceOption(RabbySigner),
  (override) => (Option.isSome(override) ? override.value : realSigner),
);
