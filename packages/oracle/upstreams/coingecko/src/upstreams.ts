import type { CoinGeckoConfig } from "@folio/coingecko-client";
import type { FxUpstream, Namer, PlatformUpstream, TokenUpstream } from "@folio/oracle-basic/ports";
import type { Layer } from "effect";
import { fxUpstreamOn } from "./fx";
import { coinGeckoNamerLayer, transport } from "./layer";
import { platformUpstreamOn } from "./platform";
import { tokenUpstreamOn } from "./upstream";

/**
 * **三个端口 + 命名身份,共用一个 client。** 装配点一次请求把三个端口都挂上时走这里。
 *
 * 为什么要它:三个 `coinGecko*UpstreamLayer(config)` 各自 `transport(config)`,得到的是**三个不同的
 * layer 引用**,而 Effect 的 layer memoisation 按引用认 —— 于是一次请求建三遍 `CoinGeckoClient`
 *(生产 bundle 的 profile 里每遍约 1.7ms CPU),哪怕 config 逐字相同。
 * 这里只 `transport(config)` 一次,三个端口挂在**同一个引用**上,一次构建只建一份。
 *
 * 出口仍是**各自一个 layer**(ADR 0023):装配点照旧逐个挑,哪天汇率换一家,换掉 `fx` 那一格
 * 就行 —— 共用的只是「恰好都是 CoinGecko 时」的那一个传输层。
 *
 * 限频不受影响:闸的游标本来就按 key 活在模块级(见 layer.ts),建一份还是三份都是同一个闸。
 */
export const coinGeckoUpstreamLayers = (
  config: CoinGeckoConfig = {},
): {
  readonly token: Layer.Layer<TokenUpstream>;
  readonly fx: Layer.Layer<FxUpstream>;
  readonly platform: Layer.Layer<PlatformUpstream>;
  readonly namer: Layer.Layer<Namer>;
} => {
  const shared = transport(config);
  return {
    token: tokenUpstreamOn(shared),
    fx: fxUpstreamOn(shared),
    platform: platformUpstreamOn(shared),
    namer: coinGeckoNamerLayer,
  };
};
