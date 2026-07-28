import { env } from "cloudflare:workers";
import { DEFAULT_TOP_N, tokenTicket, type UpstreamToken } from "@folio/oracle2";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { TokenOption } from "../token-option";
import { NAMER, oracleFor } from "./internal/oracle2";
import { requireAuth } from "./internal/require-auth";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 选币的三个 server fn(#202b:整条搬到新参考层)。
//
// **点中不建行。** 三个都只是读:发目录、搜长尾、取价。代币行是提交表单时由 mint 建的 —— 用户在
// 下拉里划过十个币不该在库里留十行垃圾。因此这里给出去的不是内部 id(那时还没有),
// 而是一张**票**:base64url 编过的 tokenRef,前端原样搬运(见 lib/token-option.ts)。

// 上游结果 → 下拉项。**logo 是上游直链,不走 folio 代理**:代理端点按内部代币行 id 读库
// (`/api/logo/token/$id`),而这些币还没有行。ADR 0008 早就把搜索这一档记成已接受的尾巴,
// 这里只是让默认列跟它一致 —— 而默认列恰好是最无所谓的那一档:市值前 N 名人人都一样,
// 浏览器去 CoinGecko 取这几张图不泄露任何人持有什么。
const toOption = (t: UpstreamToken): TokenOption => ({
  ticket: tokenTicket.encode(t.ref),
  symbol: t.symbol,
  name: t.name,
  logo: t.logo,
});

// 两个端点的**边缘缓存**(Workers Cache)。这是**一份跨用户共享**的缓存(键里没有 userId),
// 能这么做是因为两份数据一个字都与用户无关:目录是上游的市值前 N 名(`fetchMarkets` 不带任何
// 用户参数),搜索是按关键词问上游 —— 都不读持仓、不写库,`oracleFor(userId)` 只是门面的形状。
// 各人的目录在 D1 里仍是 per-user 各存一份(原则 #6),边缘这份命中谁的取决于谁先来,
// 差别最多是一个刷新周期的新旧。注意 Workers Cache 是**按机房**的,不是全球一份。
//
// **键里必须带源的名字。** 今天全仓只有一个上游,加不加都一样;但缓存的内容是「某一家怎么说」——
// 哪天源变成用户可选(ADR 0014 目前是不做),不带源的键就会把 A 那家的目录发给选了别家的 B,
// 而且是静默的。那一天要改的是这里:名字得从**那个用户的**参考层取,不能再是模块常量。
//
// —— **在 `*.workers.dev` 上这一整段是空转** ——
// Cloudflare 只在**自定义域**(与 Pages functions)上让 Cache API 真正生效;workers.dev 的缓存
// 是 zone 级的、那个 zone 上所有人共用,所以那里的 cache 操作没有效果。而 DEPLOY.md 的默认路子
// 恰好就是 workers.dev —— 不挂自己的域名,这份缓存一次都不会命中。
// https://developers.cloudflare.com/workers/runtime-apis/cache/
//
// 这种「没生效」**不抛错**,所以 catch 里的日志一条都不会打。想知道它到底有没有在干活,看下面
// 那对 debug:**只见 `stored` 不见 `hit`,就是没生效**(或者 TTL 内确实没人再来问同一个键)。
// catch 里的 warn 管的是另一回事 —— 真故障(缓存不可用 / 这条存不下)。它以前是静默吞掉的,
// 而一个永远失败的缓存不该没有人知道。
//
// 缓存读写失败一律不阻断:退化成每次现算,只慢不错。dev(Miniflare)的 Cache 也可能不持久。
const reason = (err: unknown): string => (err instanceof Error ? err.message : "unknown");

const SEARCH_CACHE_TTL_S = 300;
const CATALOGUE_CACHE_TTL_S = 600;
const TOKEN_CACHE_NAME = "folio-token-search";

async function edgeCached(
  path: string,
  ttlSeconds: number,
  load: () => Promise<TokenOption[]>,
): Promise<TokenOption[]> {
  // 键只是个名字 —— Cache API 强制它长成 URL,没有这个主机、也没人会去连它。
  const key = new Request(`https://folio.internal/${NAMER}/${path}`);
  const op = path.split("?")[0]; // 日志只记「哪个端点」,不记搜索词
  try {
    const cache = await caches.open(TOKEN_CACHE_NAME);
    const hit = await cache.match(key);
    if (hit) {
      tokenLog.debug("edge cache: hit", { op });
      return (await hit.json()) as TokenOption[];
    }
  } catch (err) {
    tokenLog.warn("edge cache: read failed", { op, error: reason(err) });
  }
  const out = await load();
  try {
    const cache = await caches.open(TOKEN_CACHE_NAME);
    await cache.put(
      key,
      new Response(JSON.stringify(out), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${ttlSeconds}`,
        },
      }),
    );
    tokenLog.debug("edge cache: stored", { op });
  } catch (err) {
    tokenLog.warn("edge cache: write failed", { op, error: reason(err) });
  }
  return out;
}

// 选币目录:市值前 N 名整份下发,浏览器拿它就地搜(见 lib/token-search.ts)。
//
// 为什么整份发而不是每敲一次字问一次服务端:这份表本来就整份躺在目录缓存里,而用户看到默认列
// 只有几十条、觉得不够就会动手敲字 —— 那是完全正常的操作,不该每次都换来一趟往返 + 一次 CGK
// 的 /search。整份约 35KB(brotli),换来的是「敲一个字就出结果」,而且第 51–1000 名的币
// 本地也搜得到 —— 以前它们只有问上游才找得着。
export const listTokenCatalogue = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<TokenOption[]> => {
    tokenLog.debug("catalogue: enter", { hasKey: !!env.COINGECKO_API_KEY });
    const out = await edgeCached(
      "token-catalogue",
      CATALOGUE_CACHE_TTL_S,
      // 已按市值排好序 —— **顺序即排名**,不额外发一列 rank 给浏览器。
      async () => (await oracleFor(context.userId).tokens.topTokens(DEFAULT_TOP_N)).map(toOption),
    );
    tokenLog.debug("catalogue: ok", { count: out.length });
    return out;
  });

// 选币 autocomplete:按关键词问上游。**只在浏览器本地目录凑不够时才被调到**(见 token-search.ts)——
// 所以到这儿的词基本都是长尾币,一次 /search 花得值。
export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data, context }): Promise<TokenOption[]> => {
    const q = data.query.trim();
    tokenLog.debug("searchTokens: enter", { query: q, hasKey: !!env.COINGECKO_API_KEY });
    if (!q) return [];
    // 抛错兜底在 requireAuth 中间件集中打日志(带 userId),此处只表达业务。
    const out = await edgeCached(
      `token-search?q=${encodeURIComponent(q)}`,
      SEARCH_CACHE_TTL_S,
      async () => (await oracleFor(context.userId).tokens.search(q)).map(toOption),
    );
    tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
    return out;
  });

// 选中之后取现价预填单价(用户可改)。**票解不开就当没选** —— 它是从网络上来的。
export const getTokenPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ ticket: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const ref = tokenTicket.decode(data.ticket, NAMER);
    if (!ref) {
      tokenLog.debug("tokenPrice: bad ticket");
      return null;
    }
    const hit = await oracleFor(context.userId).tokens.priceByRef(ref);
    tokenLog.debug("tokenPrice: ok", { found: !!hit });
    return hit
      ? { unitPrice: hit.unitPrice, change24h: hit.change24h ?? null, asOf: hit.asOf }
      : null;
  });
