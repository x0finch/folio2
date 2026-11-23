// Logo proxy core (pure logic; routes wrap it). The caller passes a cache-only thunk resolving the
// upstream URL. Upstream bytes go through the edge cache keyed by upstream URL (`./edge-cache`); responses
// are often `private`, so every request still hits the Worker for auth + URL lookup and only the origin hop is saved.

import { waitUntil } from "cloudflare:workers";
import { matchLogo, storeLogo } from "./edge-cache";

const CACHE_HIT = "public, max-age=86400, stale-while-revalidate=2592000"; // 1d fresh + 30d SWR
// Per-user endpoints (token logos) must stay out of shared caches; the browser may still cache.
const CACHE_HIT_PRIVATE = "private, max-age=86400, stale-while-revalidate=2592000";
const CACHE_404 = "public, max-age=3600"; // short negative cache
const NO_STORE = "no-store"; // transient failure, retryable
// Whether the bytes came from the edge cache; only on origin-fetch / hit 200s (data: images, 404 and 502 skip it).
const EDGE_CACHE_HEADER = "x-folio-logo-cache";

// Only raster types pass through; svg/html could run script on our origin, so they become octet-stream
// (with nosniff the browser downloads instead of rendering). Real logos are png/webp.
const RASTER_CT = /^image\/(png|jpe?g|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/i;
const isRaster = (ct: string | null): ct is string => ct !== null && RASTER_CT.test(ct);
const safeContentType = (ct: string | null): string =>
  isRaster(ct) ? ct : "application/octet-stream";

const negative = (): Response =>
  new Response(null, { status: 404, headers: { "cache-control": CACHE_404 } });
const transient = (): Response =>
  new Response(null, { status: 502, headers: { "cache-control": NO_STORE } });

// Shared by http and data: 200 responses: content-type always passes `safeContentType`.
const okHeaders = (
  ct: string | null,
  kind: "token" | "platform" | "defi",
  id: string,
  opts?: { private?: boolean },
): Record<string, string> => ({
  "content-type": safeContentType(ct),
  "x-content-type-options": "nosniff",
  "cache-control": opts?.private ? CACHE_HIT_PRIVATE : CACHE_HIT,
  "cache-tag": `logo:${kind}:${id}`,
});

// Decodes a data: image (e.g. OKX brand mark, fiat icons) without fetching. Goes through the same safety
// filter as http images, since the payload may be svg+xml/html. Malformed -> negative cache.
function serveDataUri(
  uri: string,
  kind: "token" | "platform" | "defi",
  id: string,
  opts?: { private?: boolean },
): Response {
  const comma = uri.indexOf(",");
  if (comma === -1) return negative();
  const meta = uri.slice("data:".length, comma);
  const base64 = /;base64$/i.test(meta);
  const mime = meta.replace(/;base64$/i, "").split(";")[0] || null; // drop params (charset), keep the mime
  const payload = uri.slice(comma + 1);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    // Not TextEncoder: it re-encodes code points > 127 (e.g. PNG header 0x89) as multi-byte UTF-8, corrupting binary.
    const binary = base64 ? atob(payload) : decodeURIComponent(payload);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return negative(); // bad base64 / percent-escape: treat as no image
  }
  return new Response(bytes, { status: 200, headers: okHeaders(mime, kind, id, opts) });
}

// `kind` / `id` only name the Cache-Tag.
export async function serveLogo(
  resolveUpstream: () => Promise<string | undefined>,
  kind: "token" | "platform" | "defi",
  id: string,
  // private: this response is per-user and must stay out of shared caches; the upstream-bytes cache is unaffected.
  opts?: { private?: boolean },
): Promise<Response> {
  let upstream: string | undefined;
  try {
    upstream = await resolveUpstream();
  } catch {
    upstream = undefined;
  }
  if (!upstream) return negative();

  // data: images are decoded in place, not fetched.
  if (upstream.startsWith("data:")) return serveDataUri(upstream, kind, id, opts);

  // Edge hit: headers are rebuilt per request, so the cached `public, max-age` never leaks.
  const hit = await matchLogo(upstream);
  if (hit) {
    return new Response(hit.body, {
      status: 200,
      headers: {
        ...okHeaders(hit.headers.get("content-type"), kind, id, opts),
        [EDGE_CACHE_HEADER]: "hit",
      },
    });
  }

  let res: Response;
  try {
    // Awaiting only the headers: branch on status / content-type without buffering the body.
    res = await fetch(upstream, { headers: { accept: "image/*" } });
  } catch {
    return transient();
  }
  if (res.status === 404) return negative();
  if (!res.ok) return transient();

  const ct = res.headers.get("content-type");
  let body = res.body;
  // Only raster images are cached: tee one branch to the client and one to waitUntil, so neither the response nor the worker waits on or buffers the whole image.
  if (body && isRaster(ct)) {
    const [toClient, toCache] = body.tee();
    body = toClient;
    waitUntil(storeLogo(upstream, toCache, ct));
  }

  // The ReadableStream body is passed by reference, so bytes stream through.
  return new Response(body, {
    status: 200,
    headers: { ...okHeaders(ct, kind, id, opts), [EDGE_CACHE_HEADER]: "miss" },
  });
}
