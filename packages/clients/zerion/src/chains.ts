import { staleTolerantCache, UpstreamUnavailableError } from "@folio/client-core";
import { CHAINS_CACHE_TTL_MS, CHAINS_PATH, UPSTREAM } from "./constants";
import type { ZerionChainsResponse } from "./types";

// 链清单 → slug→数字 chainId(external_id hex → 十进制)。
//
// **这个转换留在 client**,虽然它长得像 parse:它把上游的两种表示(hex 串)统一成一个数,
// 是「读懂上游怎么说话」,不涉及任何 folio 概念。适配层拿到的就该是能直接用的 chainId。
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

// 缓存 24h:chainId 不可变,不缓存就是每个账户每轮都白拉一发、还占掉那把 key 的额度。
// TTL / 陈旧回落 / 并发只拉一发 三条都在 `staleTolerantCache` 里(rabby 用的是同一个)。
export const chainsCacheFor = (baseUrl: string) =>
  staleTolerantCache<Record<string, number>>({
    upstream: UPSTREAM,
    name: "chains",
    scope: baseUrl,
    ttlMs: CHAINS_CACHE_TTL_MS,
    // 200 + 空列表存进去会让整整一天都产不出规范标识 —— 当没拉到。
    isEmpty: (map) => Object.keys(map).length === 0,
    onEmpty: () =>
      new UpstreamUnavailableError({
        upstream: UPSTREAM,
        where: CHAINS_PATH,
        cause: "chains response contained no usable chainIds",
      }),
  });
