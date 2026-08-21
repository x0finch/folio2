import { getLogger } from "@logtape/logtape";
import { Effect } from "effect";
import { NAMER } from "../oracle";
import type { TokenOption } from "./model";

const tokenLog = getLogger(["folio", "web", "tokens"]);

// 目录/搜索两个端点的**边缘缓存**(Workers Cache)。这是**一份跨用户共享**的缓存(键里没有 userId),
// 能这么做是因为两份数据一个字都与用户无关:目录是上游的市值前 N 名(`fetchMarkets` 不带任何
// 用户参数),搜索是按关键词问上游 —— 都不读持仓、不写库,`runRequest(userId, …)` 只是装配的形状。
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
// 这种「没生效」**不抛错**,所以 catch 里的日志一条都不会打。想知道它到底有没有在干活,看那对
// debug:**只见 `stored` 不见 `hit`,就是没生效**(或者 TTL 内确实没人再来问同一个键)。
// catch 里的 warn 管的是另一回事 —— 真故障(缓存不可用 / 这条存不下)。它以前是静默吞掉的,
// 而一个永远失败的缓存不该没有人知道。
//
// 缓存读写失败一律不阻断:退化成每次现算,只慢不错。dev(Miniflare)的 Cache 也可能不持久。
const reason = (err: unknown): string => (err instanceof Error ? err.message : "unknown");

export const SEARCH_CACHE_TTL_S = 300;
export const CATALOGUE_CACHE_TTL_S = 600;
const TOKEN_CACHE_NAME = "folio-token-search";

/**
 * 边缘缓存**包在 effect 外面**(#394 T5),不是包在它外面的一层 async 壳。
 *
 * 形状上的差别只有一处,但那处是要点:`load` 收的是一个 **Effect**,于是「读缓存 → 没命中就现算
 * → 写回」整段与被包住的那趟上游请求同属一个 fiber。以前是 `async` 壳里 `await runOracle(…)`,
 * 缓存 I/O 与真正的活儿之间隔着一道 Promise 边界 —— 请求被取消时,壳这半停了、里头那发 fetch
 * 还在跑。
 *
 * 缓存读写失败一律不阻断:`Effect.catchAll` 记一行然后当没命中(退化成每次现算,只慢不错)。
 * 用 `tryPromise` 而不是 `promise` 就是为了这个 —— 后者把失败变成 defect,接不住。
 */
export const edgeCached = <E, R>(
  path: string,
  ttlSeconds: number,
  load: Effect.Effect<TokenOption[], E, R>,
): Effect.Effect<TokenOption[], E, R> =>
  Effect.gen(function* () {
    // 键只是个名字 —— Cache API 强制它长成 URL,没有这个主机、也没人会去连它。
    const key = new Request(`https://folio.internal/${NAMER}/${path}`);
    const op = path.split("?")[0]; // 日志只记「哪个端点」,不记搜索词
    const hit = yield* Effect.tryPromise(async () => {
      const cache = await caches.open(TOKEN_CACHE_NAME);
      const res = await cache.match(key);
      return res ? ((await res.json()) as TokenOption[]) : null;
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          tokenLog.warn("edge cache: read failed", { op, error: reason(err.error) });
          return null;
        }),
      ),
    );
    if (hit) {
      tokenLog.debug("edge cache: hit", { op });
      return hit;
    }

    const out = yield* load;
    yield* Effect.tryPromise(async () => {
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
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() =>
          tokenLog.warn("edge cache: write failed", { op, error: reason(err.error) }),
        ),
      ),
    );
    return out;
  });
