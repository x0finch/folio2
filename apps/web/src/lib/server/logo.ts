import type { Tokens } from "@folio/tokens";

// Logo 代理核心(纯逻辑,路由只包一层)。见 ADR 0008 / PRD #18。
// token:按 cgk id 经 tokens.enrich(cache-only)拿上游 URL → fetch → 透传字节。
// 客户端零引用 CoinGecko;命中边缘缓存(Workers Cache)时连本函数都不进。

const CACHE_HIT = "public, max-age=86400, stale-while-revalidate=2592000"; // 1d 新鲜 + 30d SWR
const CACHE_404 = "public, max-age=3600"; // 短负缓存:图确实没了
const NO_STORE = "no-store"; // 瞬时故障,可重试

// 只透传栅格图类型;svg/html 等能在本域内联执行脚本的一律降级为 octet-stream(配合 nosniff
// → 浏览器直下载不渲染,挡住"上游被投毒 → 我方 origin XSS")。真实 logo 都是 png/webp,无损。
const RASTER_CT = /^image\/(png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/i;
const safeContentType = (ct: string | null): string =>
  ct && RASTER_CT.test(ct) ? ct : "application/octet-stream";

const negative = (): Response =>
  new Response(null, { status: 404, headers: { "cache-control": CACHE_404 } });
const transient = (): Response =>
  new Response(null, { status: 502, headers: { "cache-control": NO_STORE } });

// tokens 只需 enrich(cache-only 读出上游 logo URL)。
export async function serveLogo(
  tokens: Pick<Tokens, "enrich">,
  kind: string,
  id: string,
): Promise<Response> {
  if (kind !== "token") return new Response(null, { status: 404 }); // platform 见 #20

  let upstream: string | undefined;
  try {
    const [e] = await tokens.enrich([{ symbol: "", identifier: id }]);
    upstream = e?.logo ?? e?.providerLogo;
  } catch {
    upstream = undefined;
  }
  if (!upstream) return negative();

  let res: Response;
  try {
    res = await fetch(upstream, { headers: { accept: "image/*" } });
  } catch {
    return transient();
  }
  if (res.status === 404) return negative();
  if (!res.ok) return transient();

  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": safeContentType(res.headers.get("content-type")),
      "x-content-type-options": "nosniff",
      "cache-control": CACHE_HIT,
      "cache-tag": `logo:${kind}:${id}`,
    },
  });
}
