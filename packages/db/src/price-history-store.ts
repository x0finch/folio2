import type { TokenPriceHistoryStore } from "@folio/tokens";
import { and, eq, inArray } from "drizzle-orm";
import { batchWrite, chunk } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { tokenPriceHistory } from "./schema";

// 历史日价缓存的 D1 实现(全局参考数据,无 userId;#148 / ADR 0019)。过去日价不可变 → 永久存(无 TTL)。
// 键 (source, cgk_id, day_bucket);点查按 (source, cgkId) 固定 + day_bucket 分块 inArray(每块 ≤90,
// 加 2 个固定绑定仍稳在 D1 ~100 参数上限内);批量 upsert 见 cache-util。
export function createTokenPriceHistoryStore(env: DbEnv): TokenPriceHistoryStore {
  const db = getDb(env);
  return {
    async getDailyPrices(source, cgkId, dayBuckets) {
      const out = new Map<number, number>();
      for (const part of chunk([...new Set(dayBuckets)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select()
          .from(tokenPriceHistory)
          .where(
            and(
              eq(tokenPriceHistory.source, source),
              eq(tokenPriceHistory.cgkId, cgkId),
              inArray(tokenPriceHistory.dayBucket, part),
            ),
          );
        for (const r of rows) out.set(r.dayBucket, r.unitPrice);
      }
      return out;
    },

    async putDailyPrices(rows) {
      await batchWrite(
        db,
        rows.map((r) =>
          db
            .insert(tokenPriceHistory)
            .values({
              source: r.source,
              cgkId: r.cgkId,
              dayBucket: r.dayBucket,
              unitPrice: r.unitPrice,
            })
            .onConflictDoUpdate({
              target: [
                tokenPriceHistory.source,
                tokenPriceHistory.cgkId,
                tokenPriceHistory.dayBucket,
              ],
              set: { unitPrice: r.unitPrice },
            }),
        ),
      );
    },
  };
}
