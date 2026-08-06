import {
  hmacSha256,
  makeRequester,
  type Requester,
  type RequestOptions,
  SigningFailure,
  type UpstreamError,
} from "@folio/client-core";
import { Clock, Context, Effect, Layer } from "effect";
import {
  ACCOUNT_TYPE_FUND,
  ACCOUNT_TYPE_UNIFIED,
  BYBIT_API_BASE,
  EARN_POSITION_PATH,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_RECV_WINDOW,
  HEADER_SIGN,
  HEADER_SIGN_TYPE,
  HEADER_TIMESTAMP,
  RECV_WINDOW,
  SIGN_TYPE_HMAC,
  WALLET_BALANCE_PATH,
} from "./constants";
import { retCodeError, UPSTREAM } from "./errors";
import type {
  BybitCreds,
  BybitEarnResponse,
  BybitFundingResponse,
  BybitWalletBalanceResponse,
} from "./types";

export interface BybitConfig {
  // 基址,**当不透明整串用**(远程出口 IP 被 Bybit 按地区拒时由部署方注入代理 base,#264)。
  // client 不读 env、不知道代理这回事 —— 谁调谁传(ADR 0036 边界决定 2)。
  readonly apiBase?: string;
}

// Bybit v5 的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// `parse*`、locked 段的 note 文案、`totalPerpUPL` 的兜底信号判断,全在适配层(ADR 0036)。
//
// 凭据是**每次调用传**:一个 client 服务多个账户。
//
// **不带闸**(见 constants.ts:额度按账户自己那把 key 算,装了拦不到东西),**不自带重试**。
export interface BybitClientApi {
  // 统一账户(UTA)。每币自带 `usdValue` —— 估值零额外请求。
  readonly walletBalance: (
    creds: BybitCreds,
  ) => Effect.Effect<BybitWalletBalanceResponse, UpstreamError>;
  // 资金账户。
  readonly fundingBalances: (
    creds: BybitCreds,
  ) => Effect.Effect<BybitFundingResponse, UpstreamError>;
  // 赚币持仓。`category` 是 Bybit 的类目名(FlexibleSaving / OnChain)—— 拉哪几个类目、
  // 各自的展示标签叫什么,是适配层的事。
  readonly earnPositions: (
    creds: BybitCreds,
    category: string,
  ) => Effect.Effect<BybitEarnResponse, UpstreamError>;
}

export class BybitClient extends Context.Tag("clients/Bybit")<BybitClient, BybitClientApi>() {
  // base 可能每账户不同(代理覆盖是 per-account 的)→ Layer 吃 config,由适配层在那一刻 provide。
  static readonly layer = (config: BybitConfig = {}): Layer.Layer<BybitClient> =>
    Layer.succeed(BybitClient, make(config));
}

// **不是 Effect**:没有闸,构造就是纯的(同 hyperliquid)。别为形状统一而假装需要 Scope。
export function make(config: BybitConfig = {}): BybitClientApi {
  // Bybit v5 签名:`X-BAPI-SIGN = hex(HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString))`。
  //
  // **被签的 queryString 必须与实际发出去的一字不差** —— 这里用与 `makeRequester` 完全相同的
  // 构造方式(`URLSearchParams.set`,跳过 undefined)重建它。两边任何一点出入(顺序、编码、
  // 空值处理)都会让签名对不上,而 Bybit 只回一句 retCode 10004,查起来很痛。
  const signedHeaders = (
    _path: string,
    options: RequestOptions<BybitCreds> | undefined,
  ): Effect.Effect<HeadersInit, SigningFailure> =>
    Effect.gen(function* () {
      const creds = options?.context;
      if (!creds) {
        return yield* new SigningFailure({ where: _path, cause: "bybit: missing credentials" });
      }
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options?.query ?? {})) {
        if (v !== undefined) qs.set(k, String(v));
      }
      // 走 Effect 的 `Clock` 而不是 `Date.now()`:测试里能用 `TestClock` 钉住,断言签名串确定。
      const ts = String(yield* Clock.currentTimeMillis);
      const sign = yield* hmacSha256(
        creds.secret,
        ts + creds.apiKey + RECV_WINDOW + qs.toString(),
        "hex",
      );
      return {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_TIMESTAMP]: ts,
        [HEADER_RECV_WINDOW]: RECV_WINDOW,
        [HEADER_SIGN]: sign,
        [HEADER_SIGN_TYPE]: SIGN_TYPE_HMAC,
      };
    });

  // **`checkBody` 是这家上游的要点**:业务错误是 HTTP 200 + retCode ≠ 0。交给 requester 之后
  // 每个端点自动都查 —— 少查一个的后果是签名错被当成功、`result` 为空,最后表现成
  // 「这个账户余额是 0」,静默丢数据。
  const request: Requester<BybitCreds> = makeRequester<BybitCreds>({
    baseUrl: config.apiBase ?? BYBIT_API_BASE,
    upstream: UPSTREAM,
    headers: signedHeaders,
    checkBody: retCodeError,
  });

  const get = <A>(path: string, query: Record<string, string>, creds: BybitCreds) =>
    request<A>(path, { query, context: creds });

  return {
    walletBalance: (creds) =>
      get<BybitWalletBalanceResponse>(
        WALLET_BALANCE_PATH,
        { accountType: ACCOUNT_TYPE_UNIFIED },
        creds,
      ),

    fundingBalances: (creds) =>
      get<BybitFundingResponse>(FUNDING_BALANCES_PATH, { accountType: ACCOUNT_TYPE_FUND }, creds),

    earnPositions: (creds, category) =>
      get<BybitEarnResponse>(EARN_POSITION_PATH, { category }, creds),
  };
}
