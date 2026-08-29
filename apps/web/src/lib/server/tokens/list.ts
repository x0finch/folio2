import { Oracle } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { toOption } from "@/lib/core/token-model";
import { edgeCached, SEARCH_CACHE_TTL_S } from "./edge-cache";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币 autocomplete:按关键词问上游。**只在浏览器本地目录凑不够时才被调到**(见 token-search.ts)——
// 所以到这儿的词基本都是长尾币,一次 /search 花得值。
export const ListTokensInput = z.object({ query: z.string() });

export const handleListTokens = Effect.fn("listTokens")(function* (
  data: z.infer<typeof ListTokensInput>,
) {
  const q = data.query.trim();
  tokenLog.debug("searchTokens: enter", { query: q });
  if (!q) return [];
  // 抛错兜底在 requireAuth 中间件集中打日志(带 userId),此处只表达业务。
  const out = yield* edgeCached(
    `token-search?q=${encodeURIComponent(q)}`,
    SEARCH_CACHE_TTL_S,
    Effect.map(
      Effect.flatMap(Oracle, (o) => o.tokens.search(q)),
      (rows) => rows.map(toOption),
    ),
  );
  tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
  return out;
});
