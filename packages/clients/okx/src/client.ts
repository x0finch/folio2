import {
  hmacSha256,
  makeRequester,
  type Outbound,
  type Requester,
  type SigningFailure,
  type UpstreamError,
} from "@folio/client-core";
import { Clock, Context, Effect, Layer } from "effect";
import {
  ASSET_VALUATION_PATH,
  BALANCE_PATH,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_PASSPHRASE,
  HEADER_SIGN,
  HEADER_TIMESTAMP,
  OKX_API_BASE,
  POSITIONS_PATH,
  SAVINGS_BALANCE_PATH,
  STAKING_ORDERS_ACTIVE_PATH,
  VALUATION_CCY,
} from "./constants";
import { codeError, UPSTREAM } from "./errors";
import type {
  OkxBalanceResponse,
  OkxCreds,
  OkxFundingResponse,
  OkxPositionsResponse,
  OkxSavingsResponse,
  OkxStakingResponse,
  OkxValuationResponse,
} from "./types";

export interface OkxConfig {
  // 基址,**当不透明整串用**(远程出口 IP 被按地区拒时由部署方注入代理 base,#264)。
  readonly apiBase?: string;
}

// OKX v5 的请求层。**方法按上游端点组织,吐的是上游形状(DTO)** ——
// `parseBalances`、价格提示表(eqUsd/eq)、earn 残差合成行、冻结 note 文案,全在适配层(ADR 0036)。
//
// 凭据是**每次调用传**(apiKey / secret / **passphrase** —— 最后这项 binance 与 Bybit 都没有)。
//
// **不带闸**(见 constants.ts),**不自带重试**。
export interface OkxClientApi {
  // 交易账户。每币自带 `eqUsd` —— 估值零额外请求(而且 eqUsd/eq 还能当别的桶的价格提示)。
  readonly balance: (creds: OkxCreds) => Effect.Effect<OkxBalanceResponse, UpstreamError, Outbound>;
  // 资金账户。
  readonly fundingBalances: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxFundingResponse, UpstreamError, Outbound>;
  // 赚币·活期出借。
  readonly savingsBalance: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxSavingsResponse, UpstreamError, Outbound>;
  // 赚币·链上活跃订单。
  readonly stakingOrders: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxStakingResponse, UpstreamError, Outbound>;
  // 各桶的权威美元额(trading / funding / earn / classic)。
  readonly assetValuation: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxValuationResponse, UpstreamError, Outbound>;
  // 合约持仓。
  readonly positions: (
    creds: OkxCreds,
  ) => Effect.Effect<OkxPositionsResponse, UpstreamError, Outbound>;
}

export class OkxClient extends Context.Tag("clients/Okx")<OkxClient, OkxClientApi>() {
  // base 可能每账户不同(代理覆盖是 per-account 的)→ Layer 吃 config。
  static readonly layer = (config: OkxConfig = {}): Layer.Layer<OkxClient> =>
    Layer.sync(OkxClient, () => make(config));
}

// **不是 Effect**:没有闸,构造就是纯的(同 hyperliquid / bybit)。
export function make(config: OkxConfig = {}): OkxClientApi {
  // OKX v5 签名:`OK-ACCESS-SIGN = base64(HMAC-SHA256(secret, timestamp + "GET" + requestPath))`。
  //
  // **`requestPath` 含 query** —— 这是这家上游最容易签错的地方。老代码把 `?ccy=USD` 焊进路径常量里
  // 绕过去了,那样 query 就不走 `makeRequester` 的拼装(编码、undefined 跳过全靠自己再写一遍)。
  // 这里 query 正常走 `options.query`,签名这一步按**与 `makeRequester` 完全相同的方式**
  // (`URLSearchParams.set`,跳过 undefined)把它拼回 requestPath。两边有一点出入,OKX 就回 50113。
  //
  // 时间戳是 **ISO 串**(不是毫秒数)—— 又一处与 binance / Bybit 不同。
  const signedHeaders = (
    path: string,
    creds: OkxCreds,
    query: Record<string, string> | undefined,
  ): Effect.Effect<HeadersInit, SigningFailure> =>
    Effect.gen(function* () {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const requestPath = qs.size > 0 ? `${path}?${qs.toString()}` : path;
      // 走 Effect 的 `Clock` 而不是 `new Date()`:测试里能用 `TestClock` 钉住,断言签名串确定。
      const ts = new Date(yield* Clock.currentTimeMillis).toISOString();
      const sign = yield* hmacSha256(creds.secret, `${ts}GET${requestPath}`, "base64");
      return {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_SIGN]: sign,
        [HEADER_TIMESTAMP]: ts,
        [HEADER_PASSPHRASE]: creds.passphrase,
        "Content-Type": "application/json",
      };
    });

  const request: Requester = makeRequester({
    baseUrl: config.apiBase ?? OKX_API_BASE,
    upstream: UPSTREAM,
  });

  // **业务错误是 HTTP 200 + code ≠ "0"(字符串),这是这家上游的要点** —— 不查的后果是签名错被
  // 当成功、`data` 为空,最后表现成「这个账户余额是 0」,静默丢数据。
  //
  // 查它的位置是**这个唯一的 `get()`**:六个端点都从这里出去,所以漏不掉;而它是看得见的一步,
  // 不是 core 配置对象上的一个回调字段(那种写法让「一发请求算不算成功」的答案藏在别的包里)。
  const get = <A>(path: string, creds: OkxCreds, query?: Record<string, string>) =>
    request<A>(path, { query, headers: signedHeaders(path, creds, query) }).pipe(
      Effect.flatMap((body) => {
        const rejected = codeError(body, path);
        return rejected ? Effect.fail(rejected) : Effect.succeed(body);
      }),
    );

  return {
    balance: (creds) => get<OkxBalanceResponse>(BALANCE_PATH, creds),
    fundingBalances: (creds) => get<OkxFundingResponse>(FUNDING_BALANCES_PATH, creds),
    savingsBalance: (creds) => get<OkxSavingsResponse>(SAVINGS_BALANCE_PATH, creds),
    stakingOrders: (creds) => get<OkxStakingResponse>(STAKING_ORDERS_ACTIVE_PATH, creds),
    assetValuation: (creds) =>
      get<OkxValuationResponse>(ASSET_VALUATION_PATH, creds, { ccy: VALUATION_CCY }),
    positions: (creds) => get<OkxPositionsResponse>(POSITIONS_PATH, creds),
  };
}
