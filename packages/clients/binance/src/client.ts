import {
  hmacSha256,
  makeRateLimit,
  makeRequester,
  type Outbound,
  type Requester,
  UpstreamAuthError,
  type UpstreamError,
} from "@folio/client-core";
import { Clock, Context, Duration, Effect, Layer, Schema, type Scope } from "effect";
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
import { rejectedSignatureIsAuth, UPSTREAM } from "./errors";
import {
  type BinanceCreds,
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
  readonly tickerPrices: Effect.Effect<Record<string, number>, UpstreamError, Outbound>;
  readonly spotAccount: (
    creds: BinanceCreds,
  ) => Effect.Effect<SpotAccount, UpstreamError, Outbound>;
  readonly usdmAccount: (
    creds: BinanceCreds,
  ) => Effect.Effect<FuturesAccount, UpstreamError, Outbound>;
  readonly coinmAccount: (
    creds: BinanceCreds,
  ) => Effect.Effect<CoinmAccount, UpstreamError, Outbound>;
  readonly fundingAssets: (
    creds: BinanceCreds,
  ) => Effect.Effect<readonly FundingAsset[], UpstreamError, Outbound>;
  // 理财两个端点**内部翻页取全**,出口就是全部行 —— 翻页是上游分页机制的细节,不该漏给调用方。
  readonly earnFlexible: (
    creds: BinanceCreds,
  ) => Effect.Effect<EarnFlexibleRow[], UpstreamError, Outbound>;
  readonly earnLocked: (
    creds: BinanceCreds,
  ) => Effect.Effect<EarnLockedRow[], UpstreamError, Outbound>;
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
    });

    // 公开端点:免签、带闸。
    const publicRequester = makeRequester({
      baseUrl: config.apiBase ?? BINANCE_API_BASE,
      upstream: UPSTREAM,
      limit: publicLimit,
      rateLimitedStatuses: RATE_LIMITED_STATUSES,
    });

    // 签名端点:三个 host 同样的归类,**刻意不带闸**(每账户一发、不并发,闸拦不到东西,
    // 还会把两个互不相干的账户排成一队白等)。key 头随每一发传(见 signedGet)。
    const signedRequester = (baseUrl: string): Requester =>
      makeRequester({
        baseUrl,
        upstream: UPSTREAM,
        rateLimitedStatuses: RATE_LIMITED_STATUSES,
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
    const signedGet = <A, I>(
      requester: Requester,
      path: string,
      schema: Schema.Schema<A, I>,
      params: Record<string, string | number>,
      creds: BinanceCreds,
      method: "GET" | "POST" = "GET", // 资金账户是 POST(SIGNED),参数仍走 query
    ): Effect.Effect<A, UpstreamError, Outbound> =>
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        const signable = { ...params, recvWindow: RECV_WINDOW, timestamp };
        const signature = yield* hmacSha256(
          creds.secret,
          new URLSearchParams(signable as never).toString(),
          "hex",
        );
        return yield* requester(path, schema, {
          query: { ...signable, signature },
          headers: Effect.succeed({ [API_KEY_HEADER]: creds.apiKey }),
          method,
        });
      }).pipe(
        // **只有 binance 需要这一句**:它的签名要进 **query**(不是头),所以 `hmacSha256` 是在这里
        // 直接调的,没走 `headers()` —— 而 requester 只归类它自己见过的失败。okx / bybit 的签名在
        // 头里,归类早就在包内做完了。
        //
        // 签不出来归「凭据问题」:secret 非法才会走到这,重试是白赔往返。
        Effect.catchTag("SigningFailure", (e) =>
          Effect.fail(
            new UpstreamAuthError({ upstream: UPSTREAM, where: e.where, cause: e.cause }),
          ),
        ),
        // binance 用 HTTP 400 表达「这份签名请求被拒」—— 默认规则会当成上游的锅去重试它。
        rejectedSignatureIsAuth,
      );

    // 一个 position 端点翻页取全:size=100 循环 current,直到末页(rows<size)或收满 total。
    // 不翻页时首页只给 10 条,持仓多的账户(小额自动申购常见)会静默丢掉靠后的币。
    const earnRows = <Row, I>(
      path: string,
      row: Schema.Schema<Row, I>,
      creds: BinanceCreds,
    ): Effect.Effect<Row[], UpstreamError, Outbound> =>
      Effect.gen(function* () {
        const page$ = EarnPage(row);
        const rows: Row[] = [];
        for (let current = 1; current <= EARN_MAX_PAGES; current++) {
          const page = yield* signedGet(
            spot,
            path,
            page$,
            { current, size: EARN_PAGE_SIZE },
            creds,
          );
          const batch = page.rows ?? [];
          rows.push(...batch);
          if (batch.length < EARN_PAGE_SIZE) break; // 末页(不足一页)
          const total = Number(page.total ?? 0);
          if (total > 0 && rows.length >= total) break; // 已收满 total
        }
        return rows;
      });

    return {
      tickerPrices: publicRequester(
        TICKER_PRICE_PATH,
        Schema.NullOr(Schema.Array(TickerPrice)),
      ).pipe(
        // 公开端点也走这一句 —— 与迁移前一致(那时 `classifyOverride` 挂在两个 requester 上)。
        rejectedSignatureIsAuth,
        Effect.map((raw) => {
          const map: Record<string, number> = {};
          for (const t of raw ?? []) {
            if (t.symbol) map[t.symbol] = Number(t.price ?? 0);
          }
          return map;
        }),
      ),

      spotAccount: (creds) => signedGet(spot, ACCOUNT_PATH, SpotAccount, {}, creds),

      usdmAccount: (creds) => signedGet(fapi, USDM_ACCOUNT_PATH, FuturesAccount, {}, creds),

      coinmAccount: (creds) => signedGet(dapi, COINM_ACCOUNT_PATH, CoinmAccount, {}, creds),

      fundingAssets: (creds) =>
        signedGet(spot, FUNDING_ASSET_PATH, Schema.Array(FundingAsset), {}, creds, "POST"),

      earnFlexible: (creds) => earnRows(EARN_FLEXIBLE_PATH, EarnFlexibleRow, creds),
      earnLocked: (creds) => earnRows(EARN_LOCKED_PATH, EarnLockedRow, creds),
    };
  });
}
