import { Database } from "@folio/db";
import { Effect } from "effect";

// Whether the user has any account data, to warn before a merge import. Includes archived accounts:
// they still merge on import. Not a "new user" test (a user with everything archived is `true`).
export const handleGetDataStats = Effect.fn("getDataStats")(function* () {
  const accounts = yield* (yield* Database).accounts.list();
  return { hasData: accounts.length > 0 };
});
