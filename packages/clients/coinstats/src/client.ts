import {
  makeRateLimit,
  makeRequester,
  type RateLimitScope,
  type Requester,
  type UpstreamError,
} from "@folio/client-core";
import { Context, Duration, Effect, Layer, type Scope } from "effect";
import {
  API_KEY_HEADER,
  BALANCE_PATH,
  BLOCKCHAINS_PATH,
  COINSTATS_API_BASE,
  RATE_LIMIT_BURST,
  RATE_LIMIT_KEY,
  RATE_LIMIT_PER_SEC,
  UPSTREAM,
} from "./constants";
import type { CoinstatsCoin } from "./types";

export interface CoinstatsConfig {
  readonly apiBase?: string;
  // 额度桶存在哪。**生产必须是 `isolated`**(默认):额度按 API key 算,所有用户共花一份,
  // 而 CF Workers 随时会开新 isolate —— 桶只活在进程内就等于没限。测试传 `memory`。
  readonly rateLimitScope?: RateLimitScope;
}

// CoinStats OpenAPI 的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// `parseBalances`、`tokenRef` 命名、「无 chain 的 coin 回落到 connectionId」那条规则,全在适配层。
//
// **apiKey 每次调用传**,不在建 client 时绑:它来自 ctx.creds(app 从 env 注入),而 client
// 不读 env、不知道那个变量叫什么(ADR 0036 边界决定 2)。
//
// **connectionId 也是每次传**:它是 CoinStats 协议里的链标识(query 参数),而「solana 这条链
// 对应哪个 connectionId」是适配层的知识 —— 老代码里那个工厂就住在适配层该住的位置。
export interface CoinstatsClientApi {
  // 钱包代币余额。上游直接吐一个 coin 数组(不是 { data: [...] })。
  readonly balance: (params: {
    readonly connectionId: string;
    readonly address: string;
    readonly apiKey: string;
  }) => Effect.Effect<CoinstatsCoin[], UpstreamError>;

  // 支持的链列表。**只需 key、不需地址** —— 用来实测 key 本身有没有效,而不是只检查它非空。
  // 返回值没人看(调用方只关心成没成),所以类型是 `unknown`:声明一个假的形状不如说实话。
  readonly blockchains: (apiKey: string) => Effect.Effect<unknown, UpstreamError>;
}

export class CoinstatsClient extends Context.Tag("clients/Coinstats")<
  CoinstatsClient,
  CoinstatsClientApi
>() {
  static readonly layer = (config: CoinstatsConfig = {}): Layer.Layer<CoinstatsClient> =>
    Layer.scoped(CoinstatsClient, make(config));
}

export function make(
  config: CoinstatsConfig = {},
): Effect.Effect<CoinstatsClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const limit = yield* makeRateLimit({
      key: RATE_LIMIT_KEY,
      limit: RATE_LIMIT_BURST,
      interval: Duration.millis((RATE_LIMIT_BURST / RATE_LIMIT_PER_SEC) * 1000),
      scope: config.rateLimitScope ?? "isolated",
    });

    // 头是每请求算的(apiKey 从 `context` 来)—— 所以 `headers` 是函数而不是对象。
    const request: Requester<string> = makeRequester<string>({
      baseUrl: config.apiBase ?? COINSTATS_API_BASE,
      upstream: UPSTREAM,
      limit,
      headers: (_path, options) =>
        Effect.succeed({ [API_KEY_HEADER]: options?.context ?? "", accept: "application/json" }),
    });

    return {
      balance: ({ connectionId, address, apiKey }) =>
        request<CoinstatsCoin[]>(BALANCE_PATH, {
          query: { address, connectionId },
          context: apiKey,
        }),

      blockchains: (apiKey) => request(BLOCKCHAINS_PATH, { context: apiKey }),
    };
  });
}
