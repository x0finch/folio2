import type { FxStore } from "@folio/fx";
import { batchWrite, selectByKeys } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { fxRates } from "./schema";

// FX 汇率缓存的 D1 实现(全局参考数据,无 userId)。分块点查 / 批量 upsert 见 cache-util。
export function createFxStore(env: DbEnv): FxStore {
  const db = getDb(env);
  return {
    async getRates(currencies) {
      const rows = await selectByKeys<typeof fxRates.$inferSelect>(
        db,
        fxRates,
        fxRates.currency,
        currencies,
      );
      return new Map(
        rows.map((r) => [
          r.currency,
          { currency: r.currency, usdPerUnit: r.usdPerUnit, expiresAt: r.expiresAt },
        ]),
      );
    },

    async putRates(rows) {
      await batchWrite(
        db,
        rows.map((r) =>
          db
            .insert(fxRates)
            .values({ currency: r.currency, usdPerUnit: r.usdPerUnit, expiresAt: r.expiresAt })
            .onConflictDoUpdate({
              target: fxRates.currency,
              set: { usdPerUnit: r.usdPerUnit, expiresAt: r.expiresAt },
            }),
        ),
      );
    },
  };
}
