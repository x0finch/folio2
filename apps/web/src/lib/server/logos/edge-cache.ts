import { getLogger } from "@logtape/logtape";

const logoLog = getLogger(["folio", "web", "logos"]);

// Edge cache (Cache API, per datacenter) for logo bytes, keyed only by the upstream image URL.
// Never key by path id / user: token ids are per-user rows and defi URLs come from the user's own synced
// meta, so path keys would let one user's URL decide what another sees (cross-user poisoning). The key
// request carries no headers (`logoCacheKey` test pins this). The stored `public, max-age` only tells the
// Cache API how long to keep it; `serve.ts` rebuilds headers on hit.
// Only upstream 200 + raster content-type is stored; transient failures and non-images must not be pinned.
// Like `tokens/edge-cache.ts`, the Cache API silently no-ops on `*.workers.dev` (see DEPLOY.md): `stored`
// logs at info without any `hit` means it isn't working. Hits are reported via the `x-folio-logo-cache`
// response header, not logs, so log volume doesn't scale with icons per page.
// Read/write failures never block: fall back to the origin.

// 30 days, matching the browser SWR window (`serve.ts` CACHE_HIT); logos barely change.
export const LOGO_EDGE_TTL_S = 30 * 24 * 60 * 60;
const LOGO_CACHE_NAME = "folio-logo-bytes";
// Cache API requires an http URL; bump `v1` to invalidate everything.
const KEY_PREFIX = "https://folio.internal/logo/v1?u=";

const reason = (err: unknown): string => (err instanceof Error ? err.message : "unknown");

// No `caches` in node tests / some dev setups: act as no cache, no log.
const openCache = (): Promise<Cache> | null =>
  typeof caches === "undefined" ? null : caches.open(LOGO_CACHE_NAME);

/** Derived from the upstream URL only; no headers, so no cookie or session can leak in. */
export const logoCacheKey = (upstream: string): Request =>
  new Request(KEY_PREFIX + encodeURIComponent(upstream));

/** The cached response (body + content-type), or null on miss / unavailable cache. */
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

/** Callers have confirmed 200 + raster. Failures log one line and never throw. */
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
    logoLog.info("logo edge cache: stored");
  } catch (err) {
    logoLog.warn("logo edge cache: write failed", { error: reason(err) });
  }
}
