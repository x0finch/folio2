import { UpstreamUnavailableError } from "@folio/upstream-basic";
import { staleTolerantCache } from "@folio/upstreams";
import { CHAINS_CACHE_TTL_MS, CHAINS_PATH, UPSTREAM } from "./constants";
import type { ZerionChainsResponse } from "./types";

// Chain list to slug to numeric chainId (external_id hex to decimal). Stays in the client although it looks like parsing: it unifies
// upstream's representations into one number, "reading how upstream speaks", with no folio concept.
export function parseChainIds(res: ZerionChainsResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of res.data ?? []) {
    const hex = c.attributes?.external_id;
    if (!c.id || !hex) continue;
    const n = Number.parseInt(hex, 16);
    if (Number.isFinite(n)) out[c.id] = n;
  }
  return out;
}

// Cached 24h: chainId is immutable, and without a cache every account refetches each round and spends that key's quota.
// TTL / stale fallback / single-flight are all in `staleTolerantCache` (rabby uses the same).
export const chainsCacheFor = (baseUrl: string) =>
  staleTolerantCache<Record<string, number>>({
    upstream: UPSTREAM,
    name: "chains",
    scope: baseUrl,
    ttlMs: CHAINS_CACHE_TTL_MS,
    // A 200 with an empty list would block canonical identifiers for a whole day: treat as not fetched.
    isEmpty: (map) => Object.keys(map).length === 0,
    onEmpty: () =>
      new UpstreamUnavailableError({
        upstream: UPSTREAM,
        where: CHAINS_PATH,
        cause: "chains response contained no usable chainIds",
      }),
  });
