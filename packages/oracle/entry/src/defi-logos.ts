import { CacheStore } from "@folio/oracle-basic/ports";
import { Context, Effect, Layer, Option } from "effect";
import { readDefiLogos, writeDefiLogos } from "./cache";

// DeFi 协议 logo 的名址服务:protocol → 上游图 URL。与 `platforms` 同构,但更简单 ——
// URL 由同步时的余额 meta 直接给,**无上游拉取、无否定缓存**(没图就不写)。
// 它的 layer 因此只要一张缓存,`R` 里没有任何上游 —— 「这个服务不出网」是编译期的事。
//
// 存在的意义就是把 `/api/logo/defi` 的解析从「扫全部快照双重遍历」变成 per-user 缓存的 O(1) 读
// (#126:同 platform logo 的样板)。写在同步时(URL 现成),读在图片端点。
export interface DefiLogoResolver {
  // 单个协议的上游图 URL(缓存命中且非空 → URL;否则 `none`)。零网络、一次读。
  resolve(protocol: string): Effect.Effect<Option.Option<string>>;
  // 同步后预热:把 (protocol, logo) 对写回缓存(URL 现成,无 fetch)。同协议取首个带图者。
  warm(entries: readonly { protocol: string; logo: string }[]): Effect.Effect<void>;
}

export const DefiLogoResolver = Context.GenericTag<DefiLogoResolver>("oracle/DefiLogoResolver");

export const defiLogoResolverLayer: Layer.Layer<DefiLogoResolver, never, CacheStore> = Layer.effect(
  DefiLogoResolver,
  Effect.gen(function* () {
    const cache = yield* CacheStore;
    return {
      resolve: (protocol) =>
        Effect.map(readDefiLogos(cache, [protocol]), (hits) =>
          Option.fromNullable(hits.get(protocol)),
        ),

      warm: (entries) =>
        Effect.suspend(() => {
          const seen = new Map<string, string>();
          for (const e of entries) {
            if (e.logo && !seen.has(e.protocol)) seen.set(e.protocol, e.logo);
          }
          if (seen.size === 0) return Effect.void;
          return writeDefiLogos(
            cache,
            [...seen].map(([protocol, logo]) => ({ protocol, logo })),
          );
        }),
    };
  }),
);
