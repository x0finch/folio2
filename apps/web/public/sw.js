// Runtime-cache service worker for the installable mobile shell; not offline-first.
//   - navigation: network-first, falling back to a neutral offline.html. SSR responses are never
//     cached: they carry user data, and stale balances are worse than an honest offline page.
//   - /assets/ script/style/font (content-hashed, immutable): cache-first.
//   - everything else (/api, server fns, images, cross-origin, non-GET): network-only.
// A new worker stays in waiting; the page posts {type:"SKIP_WAITING"} to take over.
// swRoute is exported for unit tests; under node `self` has no skipWaiting, so no listeners attach.

// The vite plugin stampSwVersion replaces the placeholder with a git describe string so sw.js
// differs byte-wise on every release; otherwise browsers never detect an update.
// @sw-build __SW_BUILD__

// Bumped when unhashed URLs may have been cached; activate deletes old buckets.
const CACHE = "folio-shell-v2";
const OFFLINE_URL = "/offline.html";

// Vite emits content-hashed js/css/fonts here, so only these are safe to cache forever.
const IMMUTABLE_PREFIX = "/assets/";

/**
 * @param {{ method: string, mode: string, destination: string, sameOrigin: boolean, pathname: string }} req
 * @returns {"navigation" | "cache-first" | "network-only"}
 */
export function swRoute(req) {
  if (req.method !== "GET") return "network-only";
  if (req.mode === "navigate") return "navigation";
  if (!req.sameOrigin) return "network-only";
  if (req.pathname.startsWith("/api/")) return "network-only";
  // Require both a static destination and the hashed prefix: a SW left on a host by a prod build
  // would otherwise pin unhashed dev URLs like /src/styles.css and serve stale CSS forever.
  const staticDest =
    req.destination === "script" || req.destination === "style" || req.destination === "font";
  if (staticDest && req.pathname.startsWith(IMMUTABLE_PREFIX)) {
    return "cache-first";
  }
  return "network-only";
}

/**
 * Content type must match the request destination before caching. With `assets.run_worker_first`
 * as an array, a deleted `/assets/<old-hash>.js` returns 200 index.html instead of 404, and
 * `res.ok` alone would pin that HTML to the JS URL.
 * @param {string} destination
 * @param {string | null} contentType
 * @returns {boolean}
 */
export function isCacheableAsset(destination, contentType) {
  const type = (contentType ?? "").toLowerCase();
  if (destination === "script") return type.includes("javascript") || type.includes("ecmascript");
  if (destination === "style") return type.includes("text/css");
  if (destination === "font") return type.includes("font") || type.includes("application/octet-stream");
  return false;
}

// Only a real Service Worker scope has self.skipWaiting (not window, not node).
if (typeof self !== "undefined" && typeof self.skipWaiting === "function") {
  self.addEventListener("install", (event) => {
    // No skipWaiting: the page decides when to swap. First installs (no controller) activate naturally.
    event.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE_URL)));
  });

  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
        await self.clients.claim();
      })(),
    );
  });

  self.addEventListener("fetch", (event) => {
    const req = event.request;
    const url = new URL(req.url);
    const strategy = swRoute({
      method: req.method,
      mode: req.mode,
      destination: req.destination,
      sameOrigin: url.origin === self.location.origin,
      pathname: url.pathname,
    });

    if (strategy === "network-only") return;

    if (strategy === "navigation") {
      event.respondWith(
        fetch(req).catch(async () => {
          const cache = await caches.open(CACHE);
          return (await cache.match(OFFLINE_URL)) ?? Response.error();
        }),
      );
      return;
    }

    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && isCacheableAsset(req.destination, res.headers.get("content-type"))) {
          cache.put(req, res.clone());
        }
        return res;
      })(),
    );
  });
}
