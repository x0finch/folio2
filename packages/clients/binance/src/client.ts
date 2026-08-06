import {
  type HttpFailure,
  hmacSha256,
  makeRateLimit,
  makeRequester,
  type RateLimitScope,
  type Requester,
  type SigningFailure,
} from "@folio/client-core";
import { Clock, Context, Duration, Effect, Layer, type Scope } from "effect";
import {
  ACCOUNT_PATH,
  API_KEY_HEADER,
  BINANCE_API_BASE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_FUTURES_API_BASE,
  COINM_ACCOUNT_PATH,
  EARN_FLEXIBLE_PATH,
  EARN_LOCKED_PATH,
  EARN_MAX_PAGES,
  EARN_PAGE_SIZE,
  FUNDING_ASSET_PATH,
  PUBLIC_LIMIT_KEY,
  RATE_LIMITED_STATUSES,
  RECV_WINDOW,
  TICKER_PRICE_PATH,
  TICKER_RATE_LIMIT_BURST,
  TICKER_RATE_LIMIT_PER_SEC,
  USDM_ACCOUNT_PATH,
} from "./constants";
import { type BinanceError, fromTransportFailure } from "./errors";
import type {
  BinanceCreds,
  CoinmAccount,
  EarnFlexibleRow,
  EarnLockedRow,
  EarnPage,
  FundingAsset,
  FuturesAccount,
  SpotAccount,
  TickerPrice,
} from "./types";

export interface BinanceConfig {
  // 三个 host 各自的基址,**当不透明整串用**(远程出口 IP 被按地区拒时由部署方注入代理 base,
  // #264)。client 不读 env、不知道代理这回事 —— 谁调谁传,不传就直连官方(ADR 0036 边界决定 2)。
  readonly apiBase?: string;
  readonly fapiBase?: string;
  readonly dapiBase?: string;
  // 仅测试注入。
  readonly fetch?: typeof globalThis.fetch;
  // 公开端点那个闸的额度桶存在哪。**生产必须是 `isolated`**(默认):额度按出口 IP 算,所有账户
  // 所有用户共花一份,而 CF Workers 随时会开新 isolate —— 桶只活在进程内就等于没限。
  // 测试传 `memory`,那档是 Effect 官方实现、桶绑在 `Scope` 上,每次 `make` 一份、天然隔离。
  readonly rateLimitScope?: RateLimitScope;
}

// Binance REST 的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** —— 不带任何 folio 语义:
// 老 provider 里 `Wallet.run` 是「发请求紧接着 parse」,那个 parse 留在适配层(ADR 0036)。
//
// 凭据是**每次调用传**,不在建 client 时绑:一个 client 服务多个账户。
//
// 方法**不自带重试**,只带该带的闸。重试由调用方 `Effect.retry(策略)` 加在外面 —— 这样重试策略是
// 可组合的值(ADR 0035 要的),而且 `Effect.retry` 重跑的是整个 effect、闸在里面,「闸必须在重试内层」
// 那条语义自动成立,不需要 client 替调用方管。
export interface BinanceClientApi {
  // 全市场价,symbol → price。**唯一带闸的端点**(公开免签,按出口 IP 计额)。
  //
  // 吐 `Record` 而不是 `TickerPrice[]`:这是这个端点的自然用法(拿来查表),而把数组翻成表不是业务
  // 翻译、不涉及任何 folio 概念 —— 留给调用方就是每个调用方重复同一个 for 循环。
  readonly tickerPrices: Effect.Effect<Record<string, number>, BinanceError>;
  readonly spotAccount: (creds: BinanceCreds) => Effect.Effect<SpotAccount, BinanceError>;
  readonly usdmAccount: (creds: BinanceCreds) => Effect.Effect<FuturesAccount, BinanceError>;
  readonly coinmAccount: (creds: BinanceCreds) => Effect.Effect<CoinmAccount, BinanceError>;
  readonly fundingAssets: (creds: BinanceCreds) => Effect.Effect<FundingAsset[], BinanceError>;
  // 理财两个端点**内部翻页取全**,出口就是全部行 —— 翻页是上游分页机制的细节,不该漏给调用方。
  readonly earnFlexible: (creds: BinanceCreds) => Effect.Effect<EarnFlexibleRow[], BinanceError>;
  readonly earnLocked: (creds: BinanceCreds) => Effect.Effect<EarnLockedRow[], BinanceError>;
}

export class BinanceClient extends Context.Tag("clients/Binance")<
  BinanceClient,
  BinanceClientApi
>() {
  // 每次调用 fetchBalances 时 base 可能不同(代理覆盖是 per-account 的)→ Layer 吃 config,
  // 由适配层在那一刻 provide。**Layer 重建不会重置额度**:`isolated` 档的游标在模块级 + Cache API,
  // 刻意不在 `Scope` 里(Layer memoisation 是 per-run 的)。
  static readonly layer = (config: BinanceConfig = {}): Layer.Layer<BinanceClient> =>
    Layer.scoped(BinanceClient, make(config));
}

export function make(
  config: BinanceConfig = {},
): Effect.Effect<BinanceClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const publicLimit = yield* makeRateLimit({
      key: PUBLIC_LIMIT_KEY,
      limit: TICKER_RATE_LIMIT_BURST,
      interval: Duration.millis((TICKER_RATE_LIMIT_BURST / TICKER_RATE_LIMIT_PER_SEC) * 1000),
      scope: config.rateLimitScope ?? "isolated",
    });

    const shared = {
      rateLimitedStatuses: RATE_LIMITED_STATUSES,
      fetch: config.fetch,
    } as const;

    // 公开端点:免签、带闸。
    const publicRequester = makeRequester({
      baseUrl: config.apiBase ?? BINANCE_API_BASE,
      limit: publicLimit,
      ...shared,
    });

    // 签名端点:三个 host 同样的签名头 + 归类,**刻意不带闸**(每账户一发、不并发,闸拦不到东西,
    // 还会把两个互不相干的账户排成一队白等)。`context` 走 apiKey —— 头是每请求算的。
    const signedRequester = (baseUrl: string): Requester<string> =>
      makeRequester<string>({
        baseUrl,
        headers: (_path, options) => Effect.succeed({ [API_KEY_HEADER]: options?.context ?? "" }),
        ...shared,
      });

    const spot = signedRequester(config.apiBase ?? BINANCE_API_BASE);
    const fapi = signedRequester(config.fapiBase ?? BINANCE_FUTURES_API_BASE);
    const dapi = signedRequester(config.dapiBase ?? BINANCE_DELIVERY_API_BASE);

    // 签名拉一发 SIGNED 端点。
    //
    // **签名算的是「除 signature 外、按发送顺序拼起来的 query」**,所以这里用同一个 params 对象先拼
    // 一遍来签,再把 signature 追加到最后 —— `URLSearchParams` 与 `Object.entries` 都保持插入序,
    // 两边一致。顺序错了 binance 一律回 400(-1022 签名对不上)。
    //
    // `timestamp` 走 Effect 的 `Clock` 而不是 `Date.now()`:测试里能用 `TestClock` 钉住,
    // 断言签名串是确定的。
    const signedGet = (
      requester: Requester<string>,
      path: string,
      params: Record<string, string | number>,
      creds: BinanceCreds,
      method: "GET" | "POST" = "GET", // 资金账户是 POST(SIGNED),参数仍走 query
    ): Effect.Effect<unknown, BinanceError> =>
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        const signable = { ...params, recvWindow: RECV_WINDOW, timestamp };
        const signature = yield* hmacSha256(
          creds.secret,
          new URLSearchParams(signable as never).toString(),
          "hex",
        );
        return yield* requester(path, {
          query: { ...signable, signature },
          context: creds.apiKey,
          init: { method },
        });
      }).pipe(Effect.mapError((e: HttpFailure | SigningFailure) => fromTransportFailure(e)));

    // 一个 position 端点翻页取全:size=100 循环 current,直到末页(rows<size)或收满 total。
    // 不翻页时首页只给 10 条,持仓多的账户(小额自动申购常见)会静默丢掉靠后的币。
    const earnRows = <Row>(path: string, creds: BinanceCreds): Effect.Effect<Row[], BinanceError> =>
      Effect.gen(function* () {
        const rows: Row[] = [];
        for (let current = 1; current <= EARN_MAX_PAGES; current++) {
          const page = (yield* signedGet(
            spot,
            path,
            { current, size: EARN_PAGE_SIZE },
            creds,
          )) as EarnPage<Row>;
          const batch = page.rows ?? [];
          rows.push(...batch);
          if (batch.length < EARN_PAGE_SIZE) break; // 末页(不足一页)
          const total = Number(page.total ?? 0);
          if (total > 0 && rows.length >= total) break; // 已收满 total
        }
        return rows;
      });

    return {
      tickerPrices: publicRequester(TICKER_PRICE_PATH).pipe(
        Effect.map((raw) => {
          const map: Record<string, number> = {};
          for (const t of (raw as TickerPrice[] | null) ?? []) {
            if (t.symbol) map[t.symbol] = Number(t.price ?? 0);
          }
          return map;
        }),
        Effect.mapError((e: HttpFailure | SigningFailure) => fromTransportFailure(e)),
      ),

      spotAccount: (creds) =>
        signedGet(spot, ACCOUNT_PATH, {}, creds) as Effect.Effect<SpotAccount, BinanceError>,

      usdmAccount: (creds) =>
        signedGet(fapi, USDM_ACCOUNT_PATH, {}, creds) as Effect.Effect<
          FuturesAccount,
          BinanceError
        >,

      coinmAccount: (creds) =>
        signedGet(dapi, COINM_ACCOUNT_PATH, {}, creds) as Effect.Effect<CoinmAccount, BinanceError>,

      fundingAssets: (creds) =>
        signedGet(spot, FUNDING_ASSET_PATH, {}, creds, "POST") as Effect.Effect<
          FundingAsset[],
          BinanceError
        >,

      earnFlexible: (creds) => earnRows<EarnFlexibleRow>(EARN_FLEXIBLE_PATH, creds),
      earnLocked: (creds) => earnRows<EarnLockedRow>(EARN_LOCKED_PATH, creds),
    };
  });
}
