import { getLogger } from "@logtape/logtape";

const logoLog = getLogger(["folio", "web", "logos"]);

// logo **字节**的边缘缓存(Cache API,按机房一份,FOL-93)。
//
// **键只由上游图 URL 派生,与「谁在问」无关。** 这是它能跨用户共享的唯一理由:
// 缓存里存的是「这个公开 URL 返回了什么字节」,谁命中都一样 —— 前提是他**自己**先按自己的
// 参考层 / 缓存把 id 解析到了同一个 URL(路由里的鉴权 + 查找照旧)。反过来,**不按路径里的
// id / key 做键**:token 的 id 是 per-user 的行 id,defi 的协议 → URL 来自用户自己同步下来的
// meta —— 按路径做键,就等于让 A 库里那条 URL 决定 B 看到的图(跨用户投毒)。
// 键里没有 userId、Cookie、会话,构造键的 Request 也不带任何头(`logoCacheKey` 单测钉着)。
//
// 存进去的副本只带 content-type + 一条 `public, max-age` —— 后者只是告诉 Cache API 它能存多久,
// **不会发给浏览器**:命中时 `serve.ts` 用自己的 `okHeaders` 重建头(token 等照旧 `private`)。
//
// 只存「上游 200 + 栅格图 content-type」:404 / 5xx / 网络故障 / svg·html(降级成 octet-stream 的)
// 一律不进 —— 瞬时故障不该被钉住一个月,非图更没有理由占这份缓存。
//
// 与 `tokens/edge-cache.ts` 同一个前提:**`*.workers.dev` 上 Cache API 是静默空转**,只在自定义域
// 生效(见 DEPLOY.md)。空转不抛错 → 只见 `stored` 不见 `hit` 就是没生效。
// 读写失败一律不阻断:退化成每次回源,只慢不错。

// 30 天:与浏览器侧的 SWR 窗(`serve.ts` 的 CACHE_HIT)同长。logo 几乎不变;缓存满了 CF 会自己逐出。
export const LOGO_EDGE_TTL_S = 30 * 24 * 60 * 60;
const LOGO_CACHE_NAME = "folio-logo-bytes";
// 键只是个名字(Cache API 强制它长成 http URL);`v1` 留给「换了存法要整体作废」的那一天。
const KEY_PREFIX = "https://folio.internal/logo/v1?u=";

const reason = (err: unknown): string => (err instanceof Error ? err.message : "unknown");

// 本地 node(单测默认)/ 某些 dev 形态没有 `caches` —— 当没缓存,不打日志。
const openCache = (): Promise<Cache> | null =>
  typeof caches === "undefined" ? null : caches.open(LOGO_CACHE_NAME);

/** 缓存键:只由上游 URL 派生;不带任何头(Cookie / 会话都进不来)。 */
export const logoCacheKey = (upstream: string): Request =>
  new Request(KEY_PREFIX + encodeURIComponent(upstream));

/** 命中 → 缓存里那份响应(body + content-type);没命中 / 缓存不可用 → null。 */
export async function matchLogo(upstream: string): Promise<Response | null> {
  try {
    const cache = await openCache();
    if (!cache) return null;
    const hit = await cache.match(logoCacheKey(upstream));
    if (hit) logoLog.debug("logo edge cache: hit");
    return hit ?? null;
  } catch (err) {
    logoLog.warn("logo edge cache: read failed", { error: reason(err) });
    return null;
  }
}

/** 写回一份字节(调用方已确认是 200 + 栅格图)。失败只记一行,绝不抛。 */
export async function storeLogo(
  upstream: string,
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<void> {
  try {
    const cache = await openCache();
    if (!cache) {
      await body.cancel();
      return;
    }
    await cache.put(
      logoCacheKey(upstream),
      new Response(body, {
        headers: {
          "content-type": contentType,
          "cache-control": `public, max-age=${LOGO_EDGE_TTL_S}`,
        },
      }),
    );
    logoLog.debug("logo edge cache: stored");
  } catch (err) {
    logoLog.warn("logo edge cache: write failed", { error: reason(err) });
  }
}
