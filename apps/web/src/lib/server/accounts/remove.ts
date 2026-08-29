import { Database } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

const log = getLogger(["folio", "web", "accounts"]);

// 删除:不可逆(snapshots/manual_activity 经 ON DELETE CASCADE 级联清)。前端需二次确认。
// db 层按 (id, userId) 作用域,天然杜绝越权;不存在则影响 0 行(静默),不额外抛。
export const RemoveAccountInput = z.object({ accountId: z.string().min(1) });

export const handleRemoveAccount = Effect.fn("removeAccount")(function* (
  data: z.infer<typeof RemoveAccountInput>,
) {
  yield* (yield* Database).accounts.remove(data.accountId);
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  yield* invalidatePrecomputed();
  log.info("account deleted", { accountId: data.accountId });
  return { ok: true as const };
});
