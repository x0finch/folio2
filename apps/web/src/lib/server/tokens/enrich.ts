import { Oracle, type RefreshStaleReport } from "@folio/oracle";
import { Effect } from "effect";
import { type BalanceLike, refreshableTokenIds } from "@/lib/core/token-model";

// 代币预热助手(非 server fn,server-only)。被 sync-deps 复用。

// 持仓预热(写缓存,best-effort):把这批余额里价 / 元信息 stale/缺失的一次批量回源写回。
// cron(waitUntil)与手动 sync 后调用 —— cron 尤其需要,它没有前端来触发 pricesStale 那条刷价路径。
export const warmHeldPrices = (
  balances: BalanceLike[],
): Effect.Effect<RefreshStaleReport, never, Oracle> =>
  Effect.flatMap(Oracle, (o) => o.tokens.refreshStale(refreshableTokenIds(balances)));
