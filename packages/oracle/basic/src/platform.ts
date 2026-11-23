// A platform is where a holding sits: chain + venue. platformKey has the same shape as a tokenRef namer (`evm:<chainId>` / `<slug>`),
// since it is that namer. This layer only knows a platform's name and logo; the cache entry shape belongs to entry.
export interface PlatformMeta {
  key: string;
  name: string;
  logo?: string;
}
