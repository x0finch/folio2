import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { type TokenEnrichmentView, toTokenEnrichmentView } from "@/lib/core/portfolio";

// 用户全部已知代币的展示富化(FOL-54):**不按组合、不按快照** —— 账户页 / 总览客户端合并用。
interface TokenEnrichmentData {
  enriched: [string, TokenEnrichmentView][];
}

export const handleGetTokenEnrichment = Effect.fn("getTokenEnrichment")(function* () {
  const { transfer } = yield* Database;
  const rows = yield* transfer.listTokensForExport();
  if (rows.length === 0) return { enriched: [] } satisfies TokenEnrichmentData;
  const records = yield* Effect.flatMap(Oracle, (o) => o.tokens.enrich(rows.map((r) => r.id)));
  const enriched = [...records].map(
    ([id, r]) => [id, toTokenEnrichmentView(r)] as [string, TokenEnrichmentView],
  );
  return { enriched } satisfies TokenEnrichmentData;
});
