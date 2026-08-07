import {
  makeRateLimit,
  makeRequester,
  type Outbound,
  type Requester,
  type RequestOptions,
  type SigningFailure,
  staleTolerantCache,
  type UpstreamError,
  UpstreamUnavailableError,
} from "@folio/client-core";
import { Context, Duration, Effect, Layer, type Scope } from "effect";
import {
  CACHE_TOKEN_LIST_PATH,
  CHAIN_LIST_PATH,
  CHAINS_CACHE_TTL_MS,
  COMPLEX_PROTOCOL_LIST_PATH,
  MAX_REQUESTS_PER_SECOND,
  RABBY_API_BASE,
  RATE_LIMIT_KEY,
  TOTAL_BALANCE_PATH,
  UPSTREAM,
} from "./constants";
import { currentSigner } from "./signer";
import type { RabbyChain, RabbyProtocol, RabbyToken } from "./types";

export interface RabbyConfig {
  // 基址,**当不透明整串用**。**这家没有 #264 那个需求**(代理覆盖是给被按地区拒的交易所用的),
  // 但链映射缓存按它分桶,测试靠它天然隔离。
  readonly apiBase?: string;
}

// Rabby(实为 DeBank 后端)的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// `parseTokens` / `parseProtocols`(垃圾币过滤、负债腿取负、协议仓位展开)、`tokenRef` 命名、
// dust 过滤,全在适配层(ADR 0036)。
//
// **不要任何 API key**(这是它取代 zerion 的主要收益),代价是请求必须签名 —— 见 sign.ts。
export interface RabbyClientApi {
  // 钱包代币,**只收地址、一次回全链**。注意上游没有 usd_value 字段,价值要 amount × price 自己算。
  readonly tokens: (address: string) => Effect.Effect<RabbyToken[], UpstreamError, Outbound>;
  // DeFi 仓位,同样一次回全链。
  readonly protocols: (address: string) => Effect.Effect<RabbyProtocol[], UpstreamError, Outbound>;
  // slug → 数字 chainId(`community_id` 就是规范 EVM chainId)。**带 24h 缓存**。
  readonly chainIds: Effect.Effect<Record<string, number>, UpstreamError, Outbound>;
  // 最轻的端点。探活用。
  readonly totalBalance: (address: string) => Effect.Effect<unknown, UpstreamError, Outbound>;
}

export class RabbyClient extends Context.Tag("clients/Rabby")<RabbyClient, RabbyClientApi>() {
  static readonly layer = (config: RabbyConfig = {}): Layer.Layer<RabbyClient> =>
    Layer.scoped(RabbyClient, make(config));
}

// `community_id` 就是规范 EVM chainId(抽查 15 条全中:eth=1 bsc=56 arb=42161 …)。
// **这个转换留在 client** —— 它是「读懂上游怎么说话」,不涉及任何 folio 概念。
export function parseChainIds(chains: RabbyChain[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of chains ?? []) {
    if (!c.id || typeof c.community_id !== "number") continue;
    if (Number.isFinite(c.community_id)) out[c.id] = c.community_id;
  }
  return out;
}

export function make(config: RabbyConfig = {}): Effect.Effect<RabbyClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const baseUrl = config.apiBase ?? RABBY_API_BASE;

    // **limit=1:不许突发。** rabby 掐的是瞬时并发不是总量(见 constants.ts 那笔实测账)。
    const limit = yield* makeRateLimit({
      key: RATE_LIMIT_KEY,
      limit: 1,
      interval: Duration.millis(1000 / MAX_REQUESTS_PER_SECOND),
    });

    // 签名头。`params` 必须与真正发出去的 query 完全一致 —— 签的就是它(上游按 key 排序后哈希)。
    // `options.query` 就是 `makeRequester` 稍后要拼进 URL 的那一份,所以这里天然一致,
    // 不像 bybit / okx 要自己重建一遍 query 串。
    const signedHeaders = (
      path: string,
      options: RequestOptions<undefined> | undefined,
    ): Effect.Effect<HeadersInit, SigningFailure> =>
      Effect.gen(function* () {
        const sign = yield* currentSigner;
        const params = (options?.query ?? {}) as Record<string, unknown>;
        return { ...(yield* sign("GET", path, params)), accept: "application/json" };
      });

    const request: Requester = makeRequester({
      baseUrl,
      upstream: UPSTREAM,
      limit,
      headers: signedHeaders,
    });

    const chainsCache = staleTolerantCache<Record<string, number>>({
      upstream: UPSTREAM,
      name: "chains",
      scope: baseUrl,
      ttlMs: CHAINS_CACHE_TTL_MS,
      // 200 + 空列表存进去会让整整一天都产不出规范标识 —— 当没拉到。
      isEmpty: (map) => Object.keys(map).length === 0,
      onEmpty: () =>
        new UpstreamUnavailableError({
          upstream: UPSTREAM,
          where: CHAIN_LIST_PATH,
          cause: "chain list contained no usable chainIds",
        }),
    });

    return {
      tokens: (address) => request<RabbyToken[]>(CACHE_TOKEN_LIST_PATH, { query: { id: address } }),

      protocols: (address) =>
        request<RabbyProtocol[]>(COMPLEX_PROTOCOL_LIST_PATH, { query: { id: address } }),

      chainIds: chainsCache.get(
        request<RabbyChain[]>(CHAIN_LIST_PATH).pipe(Effect.map(parseChainIds)),
      ),

      totalBalance: (address) => request(TOTAL_BALANCE_PATH, { query: { id: address } }),
    };
  });
}
