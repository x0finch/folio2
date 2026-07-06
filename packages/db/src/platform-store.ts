import type { PlatformRow, PlatformStore } from "@folio/platforms";
import { inArray } from "drizzle-orm";
import { type DbEnv, getDb } from "./client";
import { platforms } from "./schema";

// D1 上限 ~100 绑定参数;inArray 分块(沿用 token-store 约束)。
const IN_CHUNK = 90;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 平台元数据缓存的 D1 实现(全局参考数据,无 userId)。只经此工厂访问,不外泄 db/schema。
export function createPlatformStore(env: DbEnv): PlatformStore {
  const db = getDb(env);
  return {
    async getPlatforms(keys) {
      const out = new Map<string, PlatformRow>();
      const unique = [...new Set(keys)];
      for (const part of chunk(unique, IN_CHUNK)) {
        if (part.length === 0) continue;
        const rows = await db.select().from(platforms).where(inArray(platforms.id, part));
        for (const r of rows) {
          out.set(r.id, { key: r.id, name: r.name, logo: r.logo, expiresAt: r.expiresAt });
        }
      }
      return out;
    },

    async putPlatforms(rows) {
      if (rows.length === 0) return;
      const stmts = rows.map((r) =>
        db
          .insert(platforms)
          .values({ id: r.key, name: r.name, logo: r.logo, expiresAt: r.expiresAt })
          .onConflictDoUpdate({
            target: platforms.id,
            set: { name: r.name, logo: r.logo, expiresAt: r.expiresAt },
          }),
      );
      const [first, ...rest] = stmts;
      if (first) await db.batch([first, ...rest]);
    },
  };
}
