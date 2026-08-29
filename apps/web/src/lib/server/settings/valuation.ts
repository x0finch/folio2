import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidateGain24h } from "@/lib/server/portfolio/gain";

// per-user 估值设置(Phase 3,#82)。读带缺省(无行 → coingecko / self-first)。
export const handleGetValuationSettings = Effect.fn("getValuationSettings")(function* () {
  return yield* (yield* Database).settings.get();
});

// 切换估值模式:source-first = 统一采用市场源价、重算当前视图(历史冻结、无需重 sync)。
export const ValuationInput = z.object({ mode: z.enum(["self-first", "source-first"]) });

export const handleUpdateValuationSettings = Effect.fn("updateValuationSettings")(function* (
  data: z.infer<typeof ValuationInput>,
) {
  yield* (yield* Database).settings.update({ valuationMode: data.mode });
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  yield* invalidateGain24h();
  return { ok: true };
});
