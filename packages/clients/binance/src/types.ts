// Binance 各端点响应的**最小形状**(仅取用到的字段)。原样搬自老 provider 包 —— 上游的形状不因为
// 换了包住的位置而改变,所以这些 interface 一个字段都没动。
//
// 字段几乎全是 `string`:binance 用字符串传数字(避免 IEEE754 精度问题)。转数字归适配层。

export interface BinanceCreds {
  readonly apiKey: string;
  readonly secret: string;
}

// —— 公开:全市场价 ——
export interface TickerPrice {
  symbol?: string;
  price?: string;
}

// —— 现货账户(/api/v3/account)——
export interface SpotBalance {
  asset?: string;
  free?: string;
  locked?: string;
}
export interface SpotAccount {
  balances?: SpotBalance[];
}

// —— U 本位合约账户(fapi /fapi/v2/account)——
export interface FuturesPosition {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  unrealizedProfit?: string;
  leverage?: string;
  notional?: string;
  isolated?: boolean;
  positionInitialMargin?: string;
}
export interface FuturesAccount {
  totalMarginBalance?: string; // 账户权益 = 钱包余额 + 未实现盈亏
  totalPositionInitialMargin?: string;
  maxWithdrawAmount?: string;
  positions?: FuturesPosition[];
}

// —— 币本位合约账户(dapi /dapi/v1/account)——
export interface CoinmAsset {
  asset?: string;
  marginBalance?: string; // per-asset 权益(币计价)
  maxWithdrawAmount?: string;
  positionInitialMargin?: string;
}
export interface CoinmPosition {
  symbol?: string;
  positionAmt?: string; // 张数(cont),非币量
  entryPrice?: string;
  unrealizedProfit?: string; // 币计价
  leverage?: string;
  notional?: string; // 币计价
  isolated?: boolean;
  positionInitialMargin?: string;
}
export interface CoinmAccount {
  assets?: CoinmAsset[];
  positions?: CoinmPosition[];
}

// —— 资金账户(/sapi/v1/asset/get-funding-asset,POST SIGNED)——
export interface FundingAsset {
  asset?: string;
  free?: string;
  locked?: string;
  freeze?: string;
  withdrawing?: string;
}

// —— 理财(Simple Earn)——
export interface EarnFlexibleRow {
  asset?: string;
  totalAmount?: string;
  latestAnnualPercentageRate?: string; // 活期浮动 APY(小数,如 "0.05")
}
export interface EarnLockedRow {
  asset?: string;
  amount?: string;
  apy?: string; // 定期 APY(小数)
  redeemDate?: number | string; // 到期(ms 时间戳)
}

// position 端点的翻页信封。**只在 client 内部用** —— 出口给的是收全了的行数组,
// 调用方不必知道翻过页(老 provider 里 `fetchEarnRows` 就在做这件事)。
export interface EarnPage<Row> {
  rows?: Row[];
  total?: number | string;
}
