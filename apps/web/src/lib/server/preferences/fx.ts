import type { DbRequest } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect, Option } from "effect";

// USD per unit of the display currency; the only read entry. No network: USD is 1, otherwise any cached rate
// however old (soft expiry). Returns `undefined` when unavailable, so the page shows USD instead of failing;
// callers don't need the cause. Rates are refreshed only by the hourly `fx` queue job, so a brand-new user may
// miss for the first hour (the switcher then says so).
export const displayRate = (
  code: string,
): Effect.Effect<number | undefined, never, Oracle | DbRequest> =>
  code === "USD"
    ? Effect.succeed(1)
    : Effect.flatMap(Oracle, ({ fx }) => Effect.map(fx.resolve(code), Option.getOrUndefined));
