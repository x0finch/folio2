import { Database } from "@folio/db";
import { Effect } from "effect";

// The user's data version: the browser caches query results and polls only this number, refetching on change.
// Bumped by DB triggers (`@folio/db` migration 0010), so no write path has to remember it.
export const handleGetDataVersion = Effect.fn("getDataVersion")(function* () {
  const version = yield* (yield* Database).dataVersion.get();
  return { version };
});
