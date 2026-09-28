import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { type TokenEnrichmentView, toTokenEnrichmentView } from "@/lib/core/portfolio";

// 用户全部已知代币的展示富化(FOL-54):**不按组合、不按快照** —— 账户页 / 总览客户端合并用。
interface TokenEnrichmentData {
  enriched: [string, TokenEnrichmentView][];
}

//
// **一次读全表**(FOL-92):以前先 `listTokensForExport`(整张代币表 + 全部 ref,只为拿 id)、再按 id
// 分块 `enrich` 读回同一批行 —— 同一张表读三遍、五条查询。`enrichAll` 按 user_id 直接读,三条。
export const handleGetTokenEnrichment = Effect.fn("getTokenEnrichment")(function* () {
  const records = yield* Effect.flatMap(Oracle, (o) => o.tokens.enrichAll());
  const enriched = [...records].map(
    ([id, r]) => [id, toTokenEnrichmentView(r)] as [string, TokenEnrichmentView],
  );
  return { enriched } satisfies TokenEnrichmentData;
});
