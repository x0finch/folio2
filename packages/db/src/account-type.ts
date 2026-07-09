// account.type 列的联合(旧 DB 值,#37d DB 迁移前保持不变)。db 拥有本列的类型事实源
//(#37c 删旧 @folio/balances 后,此 union 从旧包搬来落 db)。命名口径:<类别>_<具体>。
// 已上线 9 类(manual + 链上 5 + CEX 2 + perp 1)+ 5 个"已声明未接线"的 type
// (exchange_bybit/bitget/gate、perp_derive/extended:无 connector/UI,但历史列值含之,全集对齐避免断言)。
// #37d:DB 值迁成 connectorId(evm/bitcoin/…)+ 列改名 connectorId 后,本 union 由 @folio/connectors 的
// ConnectorId(从 registry 派生)取代。
export type AccountType =
  | "manual"
  | "onchain_evm"
  | "onchain_bitcoin"
  | "onchain_solana"
  | "onchain_sui"
  | "onchain_cosmos"
  | "exchange_binance"
  | "exchange_okx"
  | "exchange_bybit"
  | "exchange_bitget"
  | "exchange_gate"
  | "perp_hyperliquid"
  | "perp_derive"
  | "perp_extended";
