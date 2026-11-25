import { Context, Effect } from "effect";

// Read at call time by every per-user op (`bindPerCall` in database.ts), so the service graph is built once per isolate.
// A `Context.Tag`, not a `Reference`: no default, so forgetting to provide the user fails to compile instead of querying as a default user.
// Type-only outside the package; the only way to supply it is `provideCurrentUser`, restricted to the assembly point.
export class CurrentUser extends Context.Service<CurrentUser, string>()("db/CurrentUser") {}

export const provideCurrentUser =
  (userId: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentUser>> =>
    Effect.provideService(self, CurrentUser, userId);
