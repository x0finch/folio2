// Trezor Blockbook v2 响应(仅取用到的字段)。金额一律 satoshi 字符串。

// xpub 的一个派生地址(details=tokenBalances 时带 balance;tokens=used → 仅已用地址)。
export interface XpubToken {
  name: string; // 地址
  path: string; // 派生路径 m/purpose'/0'/0'/chain/index
  transfers: number;
  balance: string; // 已确认(satoshi 串)
  totalReceived?: string;
  totalSent?: string;
}

// GET /api/v2/xpub/{token}?details=tokenBalances&tokens=used —— 服务端派生 + 汇总。
export interface XpubResponse {
  address: string; // 回显的 xpub/descriptor
  balance: string; // 账户已确认总额(satoshi 串,Blockbook 已汇总)
  unconfirmedBalance: string; // 账户净未确认(satoshi 串)
  unconfirmedTxs: number;
  txs: number;
  usedTokens?: number;
  tokens?: XpubToken[]; // 已用派生地址(带余额)
}

// GET /api/v2/address/{addr}
export interface AddressResponse {
  address: string;
  balance: string;
  unconfirmedBalance: string;
  unconfirmedTxs?: number;
  txs?: number;
}
