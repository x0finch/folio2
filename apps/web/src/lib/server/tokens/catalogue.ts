import { Oracle } from "@folio/oracle";
import { DEFAULT_TOP_N } from "@folio/oracle-basic";
import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { toOption } from "@/lib/core/token-model";
import { CATALOGUE_CACHE_TTL_S, edgeCached } from "./edge-cache";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币目录:市值前 N 名整份下发,浏览器拿它就地搜(见 components/token-search.ts)。
//
// 为什么整份发而不是每敲一次字问一次服务端:这份表本来就整份躺在目录缓存里,而用户看到默认列
// 只有几十条、觉得不够就会动手敲字 —— 那是完全正常的操作,不该每次都换来一趟往返 + 一次 CGK
// 的 /search。整份约 35KB(brotli),换来的是「敲一个字就出结果」,而且第 51–1000 名的币
// 本地也搜得到 —— 以前它们只有问上游才找得着。
export const handleListTokenCatalogue = Effect.fn("listTokenCatalogue")(function* () {
  tokenLog.debug("catalogue: enter");
  const out = yield* edgeCached(
    "token-catalogue",
    CATALOGUE_CACHE_TTL_S,
    // 已按市值排好序 —— **顺序即排名**,不额外发一列 rank 给浏览器。
    Effect.map(
      Effect.flatMap(Oracle, (o) => o.tokens.topTokens(DEFAULT_TOP_N)),
      (rows) => rows.map(toOption),
    ),
  );
  tokenLog.debug("catalogue: ok", { count: out.length });
  return out;
});
