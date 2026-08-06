// CoinStats 响应的**最小形状**(仅取用到的字段)。原样搬自老 provider 包。

// wallet/balance 返回的单条 coin。响应无图标字段 → 适配层不产 logo。
export interface CoinstatsCoin {
  symbol?: string;
  name?: string;
  amount?: number;
  price?: number | null;
  chain?: string;
  contractAddress?: string | null;
}
