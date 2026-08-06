import {
  type HttpFailure,
  makeRateLimit,
  makeRequester,
  type RateLimitScope,
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
} from "./constants";
import { classify } from "./errors";
import { currentSigner } from "./signer";
import type { RabbyChain, RabbyProtocol, RabbyToken } from "./types";

export interface RabbyConfig {
  readonly apiBase?: string;
  // 额度桶存在哪。**生产必须是 `isolated`**(默认):额度跟签名走、所有账户共用一份,
  // 而 CF Workers 随时会开新 isolate —— 桶只活在进程内就等于没限。
  readonly rateLimitScope?: RateLimitScope;
}

// Rabby(实为 DeBank 后端)的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// `parseTokens` / `parseProtocols`(垃圾币过滤、负债腿取负、协议仓位展开)、`tokenRef` 命名、
// dust 过滤,全在适配层(ADR 0036)。
//
// **不要任何 API key**(这是它取代 zerion 的主要收益),代价是请求必须签名 —— 见 sign.ts。
export interface RabbyClientApi {
  // 钱包代币,**只收地址、一次回全链**。注意上游没有 usd_value 字段,价值要 amount × price 自己算。
  readonly tokens: (address: string) => Effect.Effect<RabbyToken[], UpstreamError>;
  // DeFi 仓位,同样一次回全链。
  readonly protocols: (address: string) => Effect.Effect<RabbyProtocol[], UpstreamError>;
  // slug → 数字 chainId(`community_id` 就是规范 EVM chainId)。**带 24h 缓存**。
  readonly chainIds: Effect.Effect<Record<string, number>, UpstreamError>;
  // 最轻的端点。探活用。
  readonly totalBalance: (address: string) => Effect.Effect<unknown, UpstreamError>;
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
      scope: config.rateLimitScope ?? "isolated",
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
      limit,
      headers: signedHeaders,
    });

    const toUpstream = Effect.mapError((e: HttpFailure | SigningFailure) => classify(e));

    const chainsCache = staleTolerantCache<Record<string, number>>({
      key: `rabby:chains:${baseUrl}`,
      ttlMs: CHAINS_CACHE_TTL_MS,
      // 200 + 空列表存进去会让整整一天都产不出规范标识 —— 当没拉到。
      isEmpty: (map) => Object.keys(map).length === 0,
      onEmpty: () =>
        new UpstreamUnavailableError({
          upstream: "rabby",
          where: CHAIN_LIST_PATH,
          cause: "chain list contained no usable chainIds",
        }),
    });

    return {
      tokens: (address) =>
        request<RabbyToken[]>(CACHE_TOKEN_LIST_PATH, { query: { id: address } }).pipe(toUpstream),

      protocols: (address) =>
        request<RabbyProtocol[]>(COMPLEX_PROTOCOL_LIST_PATH, { query: { id: address } }).pipe(
          toUpstream,
        ),

      chainIds: chainsCache.get(
        request<RabbyChain[]>(CHAIN_LIST_PATH).pipe(toUpstream, Effect.map(parseChainIds)),
      ),

      totalBalance: (address) =>
        request(TOTAL_BALANCE_PATH, { query: { id: address } }).pipe(toUpstream),
    };
  });
}
