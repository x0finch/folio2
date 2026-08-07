import {
  DEFAULT_TOP_N,
  FIAT_NAMER,
  FxRateResolver,
  TokenReader,
  tokenTicket,
  type UpstreamToken,
} from "@folio/oracle";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { Clock, Effect, Option } from "effect";
import { z } from "zod";
import { buildFiatOptions } from "../fiat-options";
import { pickLocale, readLocaleCookie } from "../i18n/detect";
import type { TokenOption } from "../token-option";
import { priceTickets } from "../token-pricing";
import { NAMER, runOracle } from "./internal/oracle";
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
// rank 两个家:markets 端点放在 `price.marketCapRank`(warm 重建的行只有这半),`/search` 无价
// 放在顶层 `marketCapRank` —— 取任一非空的那个。price/change/asOf 只有 markets 那侧带,搜索来的
// 行留空,由下拉 SWR 刷价补(见 refreshTokenPrices)。
const toOption = (t: UpstreamToken): TokenOption => ({
  ticket: tokenTicket.encode(t.ref),
  symbol: t.symbol,
  name: t.name,
  logo: t.logo,
  rank: t.price?.marketCapRank ?? t.marketCapRank,
  price: t.price?.unitPrice,
  change24h: t.price?.change24h,
  asOf: t.price?.asOf,
});

// 两个端点的**边缘缓存**(Workers Cache)。这是**一份跨用户共享**的缓存(键里没有 userId),
// 能这么做是因为两份数据一个字都与用户无关:目录是上游的市值前 N 名(`fetchMarkets` 不带任何
// 用户参数),搜索是按关键词问上游 —— 都不读持仓、不写库,`runOracle(userId, …)` 只是装配的形状。
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
    tokenLog.debug("catalogue: enter");
    const out = await edgeCached(
      "token-catalogue",
      CATALOGUE_CACHE_TTL_S,
      // 已按市值排好序 —— **顺序即排名**,不额外发一列 rank 给浏览器。
      async () =>
        (
          await runOracle(
            context.userId,
            Effect.flatMap(TokenReader, (t) => t.topTokens(DEFAULT_TOP_N)),
          )
        ).map(toOption),
    );
    tokenLog.debug("catalogue: ok", { count: out.length });
    return out;
  });

// 选币下拉「法币」组:SUPPORTED_CURRENCIES 的 10 法币。**票在服务端造**(前端拿不透明串,与目录/
// 已有/搜索一致;前端绝不构造 tokenRef/票 —— 见 token-option.ts 红线)。货币名按请求 locale 本地化。
// 静态数据、无网络、无 per-user —— 不走边缘缓存、不建行。requireAuth 与其余选币端点一致(只在 authed
// 加账户模态里调)。构造逻辑在纯函数 `buildFiatOptions`(server-only 消费,故文法不进客户端 bundle)。
export const listFiatOptions = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<TokenOption[]> => {
    const headers = getRequestHeaders();
    const locale = pickLocale(
      readLocaleCookie(headers.get("cookie")),
      headers.get("accept-language"),
    );
    const base = buildFiatOptions(locale);
    // 法币的「价」= FX 汇率(USD 恒 1),直接填进下拉项 —— 否则价格列显 "—"(法币在代币价格源没有价)。
    // warm 一次(冷则一把拉全所有支持币种;通常 _authed loader / 切币种时已暖过 → no-op)。
    // asOf 置当下 → 下拉 SWR(staleTickets)判它新鲜、不再拿它去 refreshTokenPrices 白刷(价已现填,重取无意义)。
    // 取不到汇率(warm 失败且非 USD)→ 该项不带价,回退 "—"(降级,不阻断)。24h 涨跌法币不给。
    return runOracle(
      context.userId,
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(base.map((o) => o.symbol));
        const asOf = yield* Clock.currentTimeMillis;
        return yield* Effect.forEach(base, (o) =>
          Effect.map(fx.resolve(o.symbol), (price) =>
            Option.isSome(price) ? { ...o, price: price.value, asOf } : o,
          ),
        );
      }),
    );
  });

// 选币 autocomplete:按关键词问上游。**只在浏览器本地目录凑不够时才被调到**(见 token-search.ts)——
// 所以到这儿的词基本都是长尾币,一次 /search 花得值。
export const listTokens = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ query: z.string() }))
  .handler(async ({ data, context }): Promise<TokenOption[]> => {
    const q = data.query.trim();
    tokenLog.debug("searchTokens: enter", { query: q });
    if (!q) return [];
    // 抛错兜底在 requireAuth 中间件集中打日志(带 userId),此处只表达业务。
    const out = await edgeCached(
      `token-search?q=${encodeURIComponent(q)}`,
      SEARCH_CACHE_TTL_S,
      async () =>
        (
          await runOracle(
            context.userId,
            Effect.flatMap(TokenReader, (t) => t.search(q)),
          )
        ).map(toOption),
    );
    tokenLog.debug("searchTokens: ok", { query: q, count: out.length });
    return out;
  });

// 选中之后取现价预填单价(用户可改)。**票解不开就当没选** —— 它是从网络上来的。
// 票可携带当前上游(加密币)或 `fiat`(法币)命名者,两者都放行(见 mintHolding 同款集合)。
export const getTokenPrice = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(z.object({ ticket: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    // 与批量刷价同一段分流(priceTickets):法币走 FX、其余走代币源。这里一次只一张票,取首条 → 无价回 null,
    // 让用户自己填(别过度设计)。**不 warm** —— 预填这一下靠 loader / listFiatOptions 已暖的缓存,别再拉一趟。
    const [priced] = await runOracle(
      context.userId,
      priceTickets([data.ticket], { namers: [NAMER, FIAT_NAMER] }),
    );
    tokenLog.debug("tokenPrice: ok", { found: priced != null });
    return priced
      ? { unitPrice: priced.unitPrice, change24h: priced.change24h, asOf: priced.asOf }
      : null;
  });

// 选币下拉的 SWR 刷价:一批票 → 现价 + 涨跌(#226)。展示时对价过期/缺失的可见行批量走一次
// `/simple/price` 回填。**POST 不是 GET**:一批票可到几十条、每条几十字符,塞进 GET 的 query
// 会把 URL 撑爆(正是 #245 那类 414);而且这是用户触发的实时刷,不该走边缘缓存。
// **不建行、不写缓存**(pricesByRefs 语义)—— 用户还在划,行只在提交时由 mint 建。
export const refreshTokenPrices = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ tickets: z.array(z.string().min(1)).max(200) }))
  .handler(async ({ data, context }) => {
    // 票携带当前上游(加密币)或 `fiat`(法币)命名者,两者都放行(同 getTokenPrice / mintHolding)——
    // 只收 NAMER 的话「已有代币」组里的法币持仓会被丢掉、价格列恒显 "—"(法币无代币市价,得走 FX)。
    // 分流(法币走 FX / 其余走代币源)在纯函数 priceTickets 里,两个选币端点共用、可单测。
    const out = await runOracle(
      context.userId,
      // `warmFiat` 开着:冷则一把拉全支持币种;通常已暖 → no-op。
      priceTickets(data.tickets, { namers: [NAMER, FIAT_NAMER], warmFiat: true }),
    );
    tokenLog.debug("refreshTokenPrices: ok", { asked: data.tickets.length, got: out.length });
    return out;
  });
