import type { PlatformStore } from "@folio/platforms";
import { batchWrite, selectByKeys } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { platforms } from "./schema";

// 平台元数据缓存的 D1 实现(全局参考数据,无 userId)。分块点查 / 批量 upsert 见 cache-util。
export function createPlatformStore(env: DbEnv): PlatformStore {
  const db = getDb(env);
  return {
    async getPlatforms(keys) {
      const rows = await selectByKeys<typeof platforms.$inferSelect>(
        db,
        platforms,
        platforms.id,
        keys,
      );
      return new Map(
        rows.map((r) => [r.id, { key: r.id, name: r.name, logo: r.logo, expiresAt: r.expiresAt }]),
      );
    },

    async putPlatforms(rows) {
      await batchWrite(
        db,
        rows.map((r) =>
          db
            .insert(platforms)
            .values({ id: r.key, name: r.name, logo: r.logo, expiresAt: r.expiresAt })
            .onConflictDoUpdate({
              target: platforms.id,
              set: { name: r.name, logo: r.logo, expiresAt: r.expiresAt },
            }),
        ),
      );
    },
  };
}
