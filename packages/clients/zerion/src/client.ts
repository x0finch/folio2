import {
  type HttpFailure,
  makeRateLimit,
  makeRequester,
  type RateLimitScope,
  type Requester,
  type SigningFailure,
  type UpstreamError,
} from "@folio/client-core";
import { Context, Duration, Effect, Layer, type Scope } from "effect";
import { cacheFor, parseChainIds } from "./chains-cache";
import {
  CHAINS_PATH,
  POSITIONS_QUERY,
  portfolioPath,
  positionsPath,
  RATE_LIMIT_BURST,
  RATE_LIMIT_KEY,
  RATE_LIMIT_PER_SEC,
  ZERION_API_BASE,
} from "./constants";
import { classify } from "./errors";
import type { ZerionChainsResponse, ZerionPositionsResponse } from "./types";

export interface ZerionConfig {
  readonly apiBase?: string;
  // 额度桶存在哪。**生产必须是 `isolated`**(默认):额度按 API key 算、全部署共用一把。
  readonly rateLimitScope?: RateLimitScope;
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
  }) => Effect.Effect<ZerionPositionsResponse, UpstreamError>;

  // slug → 数字 chainId。**带 24h 缓存**(见 chains-cache.ts):链清单近静态,每轮都拉是白费。
  // 刷新失败时回落到旧映射 —— chainId 不可变,旧的仍然正确。
  readonly chainIds: (apiKey: string) => Effect.Effect<Record<string, number>, UpstreamError>;

  // 轻量聚合。探活用 —— 负载远小于 positions。
  readonly portfolio: (params: {
    readonly address: string;
    readonly apiKey: string;
  }) => Effect.Effect<unknown, UpstreamError>;
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
      scope: config.rateLimitScope ?? "isolated",
    });

    // 头是每请求算的(apiKey 从 `context` 来)。
    const request: Requester<string> = makeRequester<string>({
      baseUrl,
      limit,
      headers: (_path, options) =>
        Effect.succeed({
          Authorization: basicAuth(options?.context ?? ""),
          accept: "application/json",
        }),
    });

    const toUpstream = Effect.mapError((e: HttpFailure | SigningFailure) => classify(e));

    // 缓存按 baseUrl 分桶、住在模块级(见 chains-cache.ts:Scope 会被每请求重置)。
    const chainsCache = cacheFor(baseUrl);

    return {
      positions: ({ address, apiKey }) =>
        request<ZerionPositionsResponse>(positionsPath(address), {
          query: POSITIONS_QUERY,
          context: apiKey,
        }).pipe(toUpstream),

      chainIds: (apiKey) =>
        chainsCache.get(
          request<ZerionChainsResponse>(CHAINS_PATH, { context: apiKey }).pipe(
            toUpstream,
            Effect.map(parseChainIds),
          ),
        ),

      portfolio: ({ address, apiKey }) =>
        request(portfolioPath(address), { context: apiKey }).pipe(toUpstream),
    };
  });
}
