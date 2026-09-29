import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { userDataVersion } from "../schema";

// 这个用户的数据版本号(FOL-94)。**只有读** —— 抬它的是迁移 0010 里的触发器(理由见 schema 里
// `userDataVersion` 那段):写 op 一个都不必记得它,也就没有哪个能忘。
//
// 没有行 = 这个用户自迁移以来还没写过任何东西 → 0。前端只比「变没变」,不看大小。
export const makeDataVersionStore = (client: DbClient, userId: string) => ({
  /** 一次主键点查。 */
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
