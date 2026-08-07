import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// OKX v5 各端点响应的**最小形状**(仅取用到的字段)。字段一个没动 —— 换的是「谁说了算」:
// 以前是 `interface` + 一次 `as`(声明而已,运行时没人查),现在是 schema,类型从它推出来。
//
// 数字字段全是 `string`;而 `code` 也是**字符串**("0"=OK)—— 与 Bybit 的数字 retCode 不同,
// 这个差异害人,所以类型里写死。

export interface OkxCreds {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string; // Bybit / binance 都没有这一项,OKX 有
}

// 所有响应共有的外层信封。**业务码在这一层查**(HTTP 200 + code ≠ "0" 也是失败)。
const envelope = {
  code: maybe(Schema.String), // **字符串**,"0"=OK
  msg: maybe(Schema.String),
};

export const OkxEnvelope = Schema.Struct(envelope);
export type OkxEnvelope = typeof OkxEnvelope.Type;

// —— 交易账户 /api/v5/account/balance ——
export const OkxDetail = Schema.Struct({
  ccy: maybe(Schema.String),
  eq: maybe(Schema.String), // 币权益(作保证金时含合约 uPnL)—— 只用来折市价,不当持有量
  eqUsd: maybe(Schema.String), // eq 的美元值 —— eqUsd/eq = 市价(不含 uPnL)
  cashBal: maybe(Schema.String), // 现金余额(不含合约 uPnL)—— 持有量口径(#259)
  frozenBal: maybe(Schema.String), // 冻结余额(原币,挂单/借贷占用)
});
export type OkxDetail = typeof OkxDetail.Type;

export const OkxBalanceResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(Schema.Struct({ details: maybe(Schema.Array(OkxDetail)) }))),
});
export type OkxBalanceResponse = typeof OkxBalanceResponse.Type;

// —— 资金账户 /api/v5/asset/balances ——(data 是扁平数组,非 details 包裹)
export const OkxFundingAsset = Schema.Struct({
  ccy: maybe(Schema.String),
  bal: maybe(Schema.String), // 总余额(含冻结)—— 持有量口径
});
export type OkxFundingAsset = typeof OkxFundingAsset.Type;

export const OkxFundingResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxFundingAsset)),
});
export type OkxFundingResponse = typeof OkxFundingResponse.Type;

// —— 赚币·活期出借 /api/v5/finance/savings/balance ——
export const OkxSavingsRow = Schema.Struct({
  ccy: maybe(Schema.String),
  amt: maybe(Schema.String), // 出借本金(持有量口径)
  rate: maybe(Schema.String), // 年化 APY(小数)
});
export type OkxSavingsRow = typeof OkxSavingsRow.Type;

export const OkxSavingsResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxSavingsRow)),
});
export type OkxSavingsResponse = typeof OkxSavingsResponse.Type;

// —— 赚币·链上活跃订单 /api/v5/finance/staking-defi/orders-active ——
export const OkxStakingInvest = Schema.Struct({
  ccy: maybe(Schema.String),
  amt: maybe(Schema.String),
});
export type OkxStakingInvest = typeof OkxStakingInvest.Type;

export const OkxStakingOrder = Schema.Struct({
  ccy: maybe(Schema.String),
  protocol: maybe(Schema.String),
  apy: maybe(Schema.String), // 年化 APY(小数)
  investData: maybe(Schema.Array(OkxStakingInvest)),
});
export type OkxStakingOrder = typeof OkxStakingOrder.Type;

export const OkxStakingResponse = Schema.Struct({
  ...envelope,
  data: maybe(Schema.Array(OkxStakingOrder)),
});
export type OkxStakingResponse = typeof OkxStakingResponse.Type;

// —— 各桶权威美元 /api/v5/asset/asset-valuation ——
export const OkxValuationDetails = Schema.Struct({
  classic: maybe(Schema.String),
  earn: maybe(Schema.String),
  funding: maybe(Schema.String),
  trading: maybe(Schema.String),
});
export type OkxValuationDetails = typeof OkxValuationDetails.Type;

export const OkxValuationResponse = Schema.Struct({
  ...envelope,
  data: maybe(
    Schema.Array(
      Schema.Struct({ totalBal: maybe(Schema.String), details: maybe(OkxValuationDetails) }),
    ),
  ),
});
export type OkxValuationResponse = typeof OkxValuationResponse.Type;

// —— 合约持仓 /api/v5/account/positions ——
export const OkxPositionsResponse = Schema.Struct({
  ...envelope,
  data: maybe(
    Schema.Array(
      Schema.Struct({
        instId: maybe(Schema.String),
        pos: maybe(Schema.String),
        upl: maybe(Schema.String),
      }),
    ),
  ),
});
export type OkxPositionsResponse = typeof OkxPositionsResponse.Type;
