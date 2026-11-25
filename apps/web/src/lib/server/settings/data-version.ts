import { Database } from "@folio/db";
import { serverFn } from "@/lib/server/server-fn";

// The user's data version: the browser caches query results and polls only this number, refetching on change.
// Bumped by DB triggers (`@folio/db` migration 0010), so no write path has to remember it.
export const handleGetDataVersion = serverFn("getDataVersion")(function* () {
  const version = yield* (yield* Database).dataVersion.get();
  return { version };
});
