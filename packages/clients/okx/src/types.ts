// OKX v5 各端点响应的**最小形状**(仅取用到的字段)。原样搬自老 provider 包。
//
// 数字字段全是 `string`;而 `code` 也是**字符串**("0"=OK)—— 与 Bybit 的数字 retCode 不同,
// 这个差异害人,所以类型里写死。

export interface OkxCreds {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string; // Bybit / binance 都没有这一项,OKX 有
}

// 所有响应共有的外层信封。
export interface OkxEnvelope {
  code?: string; // **字符串**,"0"=OK
  msg?: string;
}

// —— 交易账户 /api/v5/account/balance ——
export interface OkxDetail {
  ccy?: string;
  eq?: string; // 币权益(作保证金时含合约 uPnL)—— 只用来折市价,不当持有量
  eqUsd?: string; // eq 的美元值 —— eqUsd/eq = 市价(不含 uPnL)
  cashBal?: string; // 现金余额(不含合约 uPnL)—— 持有量口径(#259)
  frozenBal?: string; // 冻结余额(原币,挂单/借贷占用)
}

export interface OkxBalanceResponse extends OkxEnvelope {
  data?: Array<{ details?: OkxDetail[] }>;
}

// —— 资金账户 /api/v5/asset/balances ——(data 是扁平数组,非 details 包裹)
export interface OkxFundingAsset {
  ccy?: string;
  bal?: string; // 总余额(含冻结)—— 持有量口径
}

export interface OkxFundingResponse extends OkxEnvelope {
  data?: OkxFundingAsset[];
}

// —— 赚币·活期出借 /api/v5/finance/savings/balance ——
export interface OkxSavingsRow {
  ccy?: string;
  amt?: string; // 出借本金(持有量口径)
  rate?: string; // 年化 APY(小数)
}

export interface OkxSavingsResponse extends OkxEnvelope {
  data?: OkxSavingsRow[];
}

// —— 赚币·链上活跃订单 /api/v5/finance/staking-defi/orders-active ——
export interface OkxStakingInvest {
  ccy?: string;
  amt?: string;
}

export interface OkxStakingOrder {
  ccy?: string;
  protocol?: string;
  apy?: string; // 年化 APY(小数)
  investData?: OkxStakingInvest[];
}

export interface OkxStakingResponse extends OkxEnvelope {
  data?: OkxStakingOrder[];
}

// —— 各桶权威美元 /api/v5/asset/asset-valuation ——
export interface OkxValuationDetails {
  classic?: string;
  earn?: string;
  funding?: string;
  trading?: string;
}

export interface OkxValuationResponse extends OkxEnvelope {
  data?: Array<{ totalBal?: string; details?: OkxValuationDetails }>;
}

// —— 合约持仓 /api/v5/account/positions ——
export interface OkxPositionsResponse extends OkxEnvelope {
  data?: Array<{ instId?: string; pos?: string; upl?: string }>;
}
