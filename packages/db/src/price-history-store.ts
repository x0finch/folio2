import type { TokenPriceHistoryStore, TokenRef } from "@folio/tokens";
import { and, eq, inArray } from "drizzle-orm";
import { batchWrite, chunk } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { tokenPriceHistory } from "./schema";

// 历史日价缓存的 D1 实现(全局参考数据,无 userId;#148 / ADR 0019)。过去日价不可变 → 永久存(无 TTL)。
// 键 (source, identifier, day_bucket);点查按 (source, identifier) 固定 + day_bucket 分块 inArray(每块 ≤90,
// 加 2 个固定绑定仍稳在 D1 ~100 参数上限内);批量 upsert 见 cache-util。契约只认 TokenRef(不泄源内部词)。
export function createTokenPriceHistoryStore(env: DbEnv): TokenPriceHistoryStore {
  const db = getDb(env);
  const whereRef = (ref: TokenRef) =>
    and(eq(tokenPriceHistory.source, ref.source), eq(tokenPriceHistory.identifier, ref.identifier));
  return {
    async getDailyPrices(ref, dayBuckets) {
      const out = new Map<number, number>();
      for (const part of chunk([...new Set(dayBuckets)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select()
          .from(tokenPriceHistory)
          .where(and(whereRef(ref), inArray(tokenPriceHistory.dayBucket, part)));
        for (const r of rows) out.set(r.dayBucket, r.unitPrice);
      }
      return out;
    },

    async putDailyPrices(ref, prices) {
      await batchWrite(
        db,
        prices.map((p) =>
          db
            .insert(tokenPriceHistory)
            .values({
              source: ref.source,
              identifier: ref.identifier,
              dayBucket: p.dayBucket,
              unitPrice: p.unitPrice,
            })
            .onConflictDoUpdate({
              target: [
                tokenPriceHistory.source,
                tokenPriceHistory.identifier,
                tokenPriceHistory.dayBucket,
              ],
              set: { unitPrice: p.unitPrice },
            }),
        ),
      );
    },
  };
}
