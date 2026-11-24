import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { userDataVersion } from "../schema";

// Read-only: the version is bumped by DB triggers, so no write op has to remember it.
// No row = nothing written since the migration -> 0. Clients only compare for change.
export const makeDataVersionStore = (client: DbClient["Service"], userId: string) => ({
  get: (): Effect.Effect<number> =>
    Effect.map(
      client.query((db) =>
        db
          .select({ version: userDataVersion.version })
          .from(userDataVersion)
          .where(eq(userDataVersion.userId, userId)),
      ),
      (rows) => rows[0]?.version ?? 0,
    ),
});
