import {
  makeRateLimit,
  makeRequester,
  type Outbound,
  type Requester,
  type UpstreamError,
} from "@folio/client-core";
import { Context, Duration, Effect, Layer, Schema, type Scope } from "effect";
import { chainsCacheFor, parseChainIds } from "./chains";
import {
  CHAINS_PATH,
  POSITIONS_QUERY,
  portfolioPath,
  positionsPath,
  RATE_LIMIT_BURST,
  RATE_LIMIT_KEY,
  RATE_LIMIT_PER_SEC,
  UPSTREAM,
  ZERION_API_BASE,
} from "./constants";
import { ZerionChainsResponse, ZerionPositionsResponse } from "./types";

export interface ZerionConfig {
  // 基址,**当不透明整串用**。**这家没有 #264 那个需求**(代理覆盖是给被按地区拒的交易所用的),
  // 但链映射缓存按它分桶,测试靠它天然隔离。
  readonly apiBase?: string;
}

// Zerion API 的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// `parsePositions`(spot/defi 判别、负债腿取负、displayable 过滤)、`tokenRef` 命名全在适配层。
//
// **apiKey 每次调用传**:它来自 ctx.creds(app 从 env 注入),client 不读 env。
// 认证是 **HTTP Basic**:key 作 username、密码空 —— 这是 Zerion 的协议细节,归 client。
export interface ZerionClientApi {
  // 该地址的全量仓位(代币 + DeFi,跨所有 EVM 链一次返回)。
  readonly positions: (params: {
    readonly address: string;
    readonly apiKey: string;
  }) => Effect.Effect<ZerionPositionsResponse, UpstreamError, Outbound>;

  // slug → 数字 chainId。**带 24h 缓存**(见 chains-cache.ts):链清单近静态,每轮都拉是白费。
  // 刷新失败时回落到旧映射 —— chainId 不可变,旧的仍然正确。
  readonly chainIds: (
    apiKey: string,
  ) => Effect.Effect<Record<string, number>, UpstreamError, Outbound>;

  // 轻量聚合。探活用 —— 负载远小于 positions。
  readonly portfolio: (params: {
    readonly address: string;
    readonly apiKey: string;
  }) => Effect.Effect<unknown, UpstreamError, Outbound>;
}

export class ZerionClient extends Context.Tag("clients/Zerion")<ZerionClient, ZerionClientApi>() {
  static readonly layer = (config: ZerionConfig = {}): Layer.Layer<ZerionClient> =>
    Layer.scoped(ZerionClient, make(config));
}

// key 作 username、密码空 —— Zerion 的 Basic 认证形状。
const basicAuth = (apiKey: string): string => `Basic ${btoa(`${apiKey}:`)}`;

export function make(
  config: ZerionConfig = {},
): Effect.Effect<ZerionClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const baseUrl = config.apiBase ?? ZERION_API_BASE;

    const limit = yield* makeRateLimit({
      key: RATE_LIMIT_KEY,
      limit: RATE_LIMIT_BURST,
      interval: Duration.millis((RATE_LIMIT_BURST / RATE_LIMIT_PER_SEC) * 1000),
    });

    const request: Requester = makeRequester({ baseUrl, upstream: UPSTREAM, limit });

    // 头是每请求算的 —— key 来自调用方给的凭据,不是模块级常量,所以随每一发传进去。
    const keyed = (apiKey: string) =>
      Effect.succeed({ Authorization: basicAuth(apiKey), accept: "application/json" });

    // 缓存按 baseUrl 分桶、住在模块级(见 client-core 的 stale-cache:Scope 会被每请求重置)。
    const chainsCache = chainsCacheFor(baseUrl);

    return {
      positions: ({ address, apiKey }) =>
        request(positionsPath(address), ZerionPositionsResponse, {
          query: POSITIONS_QUERY,
          headers: keyed(apiKey),
        }),

      chainIds: (apiKey) =>
        chainsCache.get(
          request(CHAINS_PATH, ZerionChainsResponse, { headers: keyed(apiKey) }).pipe(
            Effect.map(parseChainIds),
          ),
        ),

      portfolio: ({ address, apiKey }) =>
        // 只用来探活「这把 key + 这个地址通不通」,回什么形状不关心。
        request(portfolioPath(address), Schema.Unknown, { headers: keyed(apiKey) }),
    };
  });
}
