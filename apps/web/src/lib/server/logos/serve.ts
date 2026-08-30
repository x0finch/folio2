// Logo 代理核心(纯逻辑,路由只包一层)。见 ADR 0008 / PRD #18。
// 与 kind 无关:调用方传一个"解析上游图 URL"的 thunk(cache-only,读 store),本函数
// fetch → 透传字节。token(按内部行 id)/ platform(按 platform key)各自的路由构造 thunk。
// 客户端零第三方 CDN 引用;命中边缘缓存(Workers Cache)时连本函数都不进。

const CACHE_HIT = "public, max-age=86400, stale-while-revalidate=2592000"; // 1d 新鲜 + 30d SWR
// 按用户收口的端点(代币 logo,#201):不能进共享缓存,但浏览器自己缓存照旧。
const CACHE_HIT_PRIVATE = "private, max-age=86400, stale-while-revalidate=2592000";
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

// 200 图响应的公共头(http 透传与 data: 内嵌图共用):content-type 一律过 `safeContentType`
// 白名单(svg/html 降级),配 nosniff + 缓存头 + Cache-Tag。
const okHeaders = (
  ct: string | null,
  kind: "token" | "platform" | "defi",
  id: string,
  opts?: { private?: boolean },
): HeadersInit => ({
  "content-type": safeContentType(ct),
  "x-content-type-options": "nosniff",
  "cache-control": opts?.private ? CACHE_HIT_PRIVATE : CACHE_HIT,
  "cache-tag": `logo:${kind}:${id}`,
});

// data-URI(如 OKX 合成行品牌标 / 法币内嵌图)→ 解出 mime + 字节直接构造 200,不 fetch。
// 走与 http 图**同一条安全过滤**(`okHeaders` → `safeContentType`):data: 里可能藏 svg+xml/html,
// 必须降级为 octet-stream + nosniff,不能让它以可执行类型在本域渲染。畸形/解码失败 → 负缓存。
function serveDataUri(
  uri: string,
  kind: "token" | "platform" | "defi",
  id: string,
  opts?: { private?: boolean },
): Response {
  const comma = uri.indexOf(",");
  if (comma === -1) return negative(); // 无逗号 → 不是合法 data-URI
  const meta = uri.slice("data:".length, comma); // 如 "image/png;base64" / "image/svg+xml"
  const base64 = /;base64$/i.test(meta);
  const mime = meta.replace(/;base64$/i, "").split(";")[0] || null; // 去参数(charset 等)只留 mime
  const payload = uri.slice(comma + 1);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    // 两个分支都按「binary string → 逐字节」取:base64 先 atob,percent-encoded 先 decodeURIComponent。
    // **不能用 TextEncoder**:它会把 >127 的码点(如 PNG 头 0x89)重编码成多字节 UTF-8,损坏二进制图。
    const binary = base64 ? atob(payload) : decodeURIComponent(payload);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return negative(); // 解码失败(坏 base64 / 坏百分号转义)当没图
  }
  return new Response(bytes, { status: 200, headers: okHeaders(mime, kind, id, opts) });
}

// resolveUpstream:cache-only 读出上游 logo URL(缺则 undefined)。kind/id 仅用于 Cache-Tag 命名。
export async function serveLogo(
  resolveUpstream: () => Promise<string | undefined>,
  kind: "token" | "platform" | "defi",
  id: string,
  // private:该响应按用户收口(见代币 logo 路由),不得进共享/边缘缓存。
  opts?: { private?: boolean },
): Promise<Response> {
  let upstream: string | undefined;
  try {
    upstream = await resolveUpstream();
  } catch {
    upstream = undefined;
  }
  if (!upstream) return negative();

  // 内嵌 data-URI 图(无法由 http 拿):就地解码,不 fetch。走同一套安全过滤 + 缓存头。
  if (upstream.startsWith("data:")) return serveDataUri(upstream, kind, id, opts);

  let res: Response;
  try {
    // await 只等响应头(不等 body):要据 status/content-type 分支。body 不落内存。
    res = await fetch(upstream, { headers: { accept: "image/*" } });
  } catch {
    return transient();
  }
  if (res.status === 404) return negative();
  if (!res.ok) return transient();

  // res.body 是 ReadableStream,按引用交出去 → 字节流式透传,worker 不缓冲整张图。
  return new Response(res.body, {
    status: 200,
    headers: okHeaders(res.headers.get("content-type"), kind, id, opts),
  });
}
