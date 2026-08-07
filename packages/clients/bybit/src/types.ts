import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// Bybit v5 各端点响应的**最小形状**(仅取用到的字段)。字段一个没动 —— 换的是「谁说了算」:
// 以前是 `interface` + 一次 `as`(声明而已,运行时没人查),现在是 schema,类型从它推出来。
//
// 数字字段全是 `string`(Bybit 用字符串传数字);而 `retCode` 是**数字**(0=OK)——
// 与 OKX 的字符串 code 不同,这个差异害人,所以类型里写死。

export interface BybitCreds {
  readonly apiKey: string;
  readonly secret: string;
}

// 所有响应共有的外层信封。**业务码在这一层查**(HTTP 200 + retCode ≠ 0 也是失败)。
const envelope = {
  retCode: maybe(Schema.Number), // **数字**,0=OK
  retMsg: maybe(Schema.String),
};

export const BybitEnvelope = Schema.Struct(envelope);
export type BybitEnvelope = typeof BybitEnvelope.Type;

// —— 统一账户(UTA)/v5/account/wallet-balance ——
export const BybitCoin = Schema.Struct({
  coin: maybe(Schema.String),
  walletBalance: maybe(Schema.String), // 现金余额(不含合约 uPnL)—— 持有量口径(ADR 0032)
  equity: maybe(Schema.String), // = walletBalance + unrealisedPnl —— **不当持有量**
  usdValue: maybe(Schema.String), // Bybit 自带的美元值 —— 估值口径,零额外请求
  locked: maybe(Schema.String), // 被订单/产品锁定的量(含在 walletBalance 里)
});
export type BybitCoin = typeof BybitCoin.Type;

export const BybitWalletBalanceResponse = Schema.Struct({
  ...envelope,
  result: maybe(
    Schema.Struct({
      list: maybe(
        Schema.Array(
          Schema.Struct({
            accountType: maybe(Schema.String),
            totalEquity: maybe(Schema.String),
            totalPerpUPL: maybe(Schema.String), // 合约未实现盈亏合计 —— 非零即有浮盈被排除在 walletBalance 外
            coin: maybe(Schema.Array(BybitCoin)),
          }),
        ),
      ),
    }),
  ),
});
export type BybitWalletBalanceResponse = typeof BybitWalletBalanceResponse.Type;

// —— 资金账户 /v5/asset/transfer/query-account-coins-balance ——
export const BybitFundingCoin = Schema.Struct({
  coin: maybe(Schema.String),
  walletBalance: maybe(Schema.String), // 总余额 —— 持有量口径
});
export type BybitFundingCoin = typeof BybitFundingCoin.Type;

export const BybitFundingResponse = Schema.Struct({
  ...envelope,
  result: maybe(Schema.Struct({ balance: maybe(Schema.Array(BybitFundingCoin)) })),
});
export type BybitFundingResponse = typeof BybitFundingResponse.Type;

// —— 赚币 /v5/earn/position ——
// **Bybit 的赚币持仓端点不带 APR 字段**(只有 amount / totalPnl / yesterdayYield)。
export const BybitEarnPosition = Schema.Struct({
  coin: maybe(Schema.String),
  amount: maybe(Schema.String), // 出借/质押本金 —— 持有量口径
});
export type BybitEarnPosition = typeof BybitEarnPosition.Type;

export const BybitEarnResponse = Schema.Struct({
  ...envelope,
  result: maybe(Schema.Struct({ list: maybe(Schema.Array(BybitEarnPosition)) })),
});
export type BybitEarnResponse = typeof BybitEarnResponse.Type;
