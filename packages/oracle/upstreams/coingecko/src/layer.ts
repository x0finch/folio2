import { FolioHttpClient, type Outbound, type UpstreamError } from "@folio/client-core";
import { CoinGeckoClient, type CoinGeckoConfig } from "@folio/coingecko-client";
import { Namer } from "@folio/oracle-basic/ports";
import { Effect, Layer } from "effect";
import { OVERRIDES, UPSTREAM_ID } from "./constants";

// 三个端口的 layer 共用的两件事。
//
// ① **传输层在这里被关掉,不外泄。** 端口的签名是 `Effect<A, UpstreamError>`(`R = never`),
//    所以 client 与 `HttpClient` 由本包自己 provide —— 参考层的 `R` 里因此只有端口本身,
//    不会长出一条 `Outbound`。谁提供这个端口是谁的事。
//
// ② **方法体的 `R` 用「装配时抓住 context」关掉。** adapter 的实现面(`makeUpstreamEffects` 等)
//    要 `CoinGeckoClient | Outbound`,而端口方法不能要 —— 于是建服务时抓一份 context,
//    每个方法出口 `Effect.provide` 进去。这样实现面仍是纯 Effect(测试直接 provide 一个假
//    `HttpClient` 就能跑,见 tests/harness.ts),而端口那一侧是干净的。
//
// 三个 layer 各建一次 client 是明知接受的:`makeRateLimit` 的游标按 key 存在模块级
// (CF Workers 上跨请求活着的那份,见 client-core),所以「建三次」不会让额度凭空回满,
// 代价只是三个闭包。换来的是三个端口各自可换供应商(ADR 0023)。
export type Needs = CoinGeckoClient | Outbound;

export const transport = (config: CoinGeckoConfig): Layer.Layer<Needs> =>
  Layer.merge(CoinGeckoClient.layer(config), FolioHttpClient);

// 抓 context → 得到一个「把实现面的 effect 收成端口形状」的函数。
export const closeOver: Effect.Effect<
  <A>(effect: Effect.Effect<A, UpstreamError, Needs>) => Effect.Effect<A, UpstreamError>,
  never,
  Needs
> = Effect.map(
  Effect.context<Needs>(),
  (ctx) =>
    <A>(effect: Effect.Effect<A, UpstreamError, Needs>): Effect.Effect<A, UpstreamError> =>
      Effect.provide(effect, ctx),
);

// **命名身份**(id + 策展表)。不需要 client,也不需要 config —— 它是纯粹的「这一家怎么称呼币」。
//
// `OVERRIDES` 因此不再由装配点从本包转手一遍(以前是 `OracleConfig.overrides`):
// 它逐条写的都是 CoinGecko 的 coin id,交给它自己的 layer 带出去,少一次搬运、也少一次接错的机会。
export const coinGeckoNamerLayer: Layer.Layer<Namer> = Layer.succeed(Namer, {
  id: UPSTREAM_ID,
  overrides: OVERRIDES,
});
