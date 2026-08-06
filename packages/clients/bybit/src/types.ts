// Bybit v5 各端点响应的**最小形状**(仅取用到的字段)。原样搬自老 provider 包。
//
// 数字字段全是 `string`(Bybit 用字符串传数字);而 `retCode` 是**数字**(0=OK)——
// 与 OKX 的字符串 code 不同,这个差异害人,所以类型里写死。

export interface BybitCreds {
  readonly apiKey: string;
  readonly secret: string;
}

// 所有响应共有的外层信封。
export interface BybitEnvelope {
  retCode?: number; // **数字**,0=OK
  retMsg?: string;
}

// —— 统一账户(UTA)/v5/account/wallet-balance ——
export interface BybitCoin {
  coin?: string;
  walletBalance?: string; // 现金余额(不含合约 uPnL)—— 持有量口径(ADR 0032)
  equity?: string; // = walletBalance + unrealisedPnl —— **不当持有量**
  usdValue?: string; // Bybit 自带的美元值 —— 估值口径,零额外请求
  locked?: string; // 被订单/产品锁定的量(含在 walletBalance 里)
}

export interface BybitWalletBalanceResponse extends BybitEnvelope {
  result?: {
    list?: Array<{
      accountType?: string;
      totalEquity?: string;
      totalPerpUPL?: string; // 合约未实现盈亏合计 —— 非零即有浮盈被排除在 walletBalance 外
      coin?: BybitCoin[];
    }>;
  };
}

// —— 资金账户 /v5/asset/transfer/query-account-coins-balance ——
export interface BybitFundingCoin {
  coin?: string;
  walletBalance?: string; // 总余额 —— 持有量口径
}

export interface BybitFundingResponse extends BybitEnvelope {
  result?: { balance?: BybitFundingCoin[] };
}

// —— 赚币 /v5/earn/position ——
// **Bybit 的赚币持仓端点不带 APR 字段**(只有 amount / totalPnl / yesterdayYield)。
export interface BybitEarnPosition {
  coin?: string;
  amount?: string; // 出借/质押本金 —— 持有量口径
}

export interface BybitEarnResponse extends BybitEnvelope {
  result?: { list?: BybitEarnPosition[] };
}
