import { Database } from "@folio/db";
import { Effect } from "effect";

export const handleListTags = Effect.fn("listTags")(function* () {
  return yield* (yield* Database).tags.list();
});
