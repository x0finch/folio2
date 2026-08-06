// `clearinghouseState` 响应的**最小形状**(仅取用到的字段)。原样搬自老 provider 包 ——
// 上游的形状不因为换了包住的位置而改变,所以这些 interface 一个字段都没动。
//
// 数字字段全是 `string`:hyperliquid 用字符串传数字。转数字归适配层。

export interface HlLeverage {
  value?: number;
  type?: string;
  rawUsd?: string;
}

export interface HlPosition {
  coin?: string;
  szi?: string; // 带符号:正=多、负=空
  entryPx?: string;
  positionValue?: string; // 名义 USD(杠杆敞口,非账户净值贡献)
  unrealizedPnl?: string;
  leverage?: HlLeverage;
  liquidationPx?: string | null;
  marginUsed?: string;
}

export interface HlMarginSummary {
  accountValue?: string; // 账户总权益(保证金 + 未实现盈亏)= 对组合净值的真实贡献
  totalMarginUsed?: string;
  totalNtlPos?: string;
  totalRawUsd?: string;
}

export interface ClearinghouseState {
  marginSummary?: HlMarginSummary;
  assetPositions?: { position?: HlPosition }[];
  withdrawable?: string;
}
