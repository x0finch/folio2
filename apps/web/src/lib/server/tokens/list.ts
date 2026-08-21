import { TokenService } from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { z } from "zod";
import { runRequest } from "../oracle";
import type { AuthContext } from "../session/auth-session";
import { edgeCached, SEARCH_CACHE_TTL_S } from "./edge-cache";
import { type TokenOption, toOption } from "./model";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币 autocomplete:按关键词问上游。**只在浏览器本地目录凑不够时才被调到**(见 token-search.ts)——
// 所以到这儿的词基本都是长尾币,一次 /search 花得值。
export const ListTokensInput = z.object({ query: z.string() });

export async function handleListTokens({
  data,
  context,
}: {
  data: z.infer<typeof ListTokensInput>;
  context: AuthContext;
}): Promise<TokenOption[]> {
  const q = data.query.trim();
  tokenLog.debug("searchTokens: enter", { query: q });
  if (!q) return [];
  // 抛错兜底在 requireAuth 中间件集中打日志(带 userId),此处只表达业务。
  const out = await runRequest(
    context.userId,
    edgeCached(
      `token-search?q=${encodeURIComponent(q)}`,
      SEARCH_CACHE_TTL_S,
      Effect.map(
        Effect.flatMap(TokenService, (t) => t.search(q)),
        (rows) => rows.map(toOption),
      ),
    ),
  );
  tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
  return out;
}
