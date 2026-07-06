import type { FxRow, FxStore } from "@folio/fx";
import { inArray } from "drizzle-orm";
import { type DbEnv, getDb } from "./client";
import { fxRates } from "./schema";

// D1 上限 ~100 绑定参数;inArray 分块(沿用 platform-store 约束)。
const IN_CHUNK = 90;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// FX 汇率缓存的 D1 实现(全局参考数据,无 userId)。只经此工厂访问,不外泄 db/schema。
export function createFxStore(env: DbEnv): FxStore {
  const db = getDb(env);
  return {
    async getRates(currencies) {
      const out = new Map<string, FxRow>();
      const unique = [...new Set(currencies)];
      for (const part of chunk(unique, IN_CHUNK)) {
        if (part.length === 0) continue;
        const rows = await db.select().from(fxRates).where(inArray(fxRates.currency, part));
        for (const r of rows) {
          out.set(r.currency, {
            currency: r.currency,
            usdPerUnit: r.usdPerUnit,
            expiresAt: r.expiresAt,
          });
        }
      }
      return out;
    },

    async putRates(rows) {
      if (rows.length === 0) return;
      const stmts = rows.map((r) =>
        db
          .insert(fxRates)
          .values({ currency: r.currency, usdPerUnit: r.usdPerUnit, expiresAt: r.expiresAt })
          .onConflictDoUpdate({
            target: fxRates.currency,
            set: { usdPerUnit: r.usdPerUnit, expiresAt: r.expiresAt },
          }),
      );
      const [first, ...rest] = stmts;
      if (first) await db.batch([first, ...rest]);
    },
  };
}
