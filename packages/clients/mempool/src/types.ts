// Esplora `/address/:addr` 响应(仅取用到的字段)。mempool.space 实现 Esplora API。
// chain_stats = 已确认(≥1 确认);mempool_stats = 未确认(在途,同结构);funded_txo_count 用于 used 判定。
export interface AddressStats {
  funded_txo_sum?: number;
  spent_txo_sum?: number;
  funded_txo_count?: number;
}
export interface AddressResponse {
  address?: string;
  chain_stats?: AddressStats;
  mempool_stats?: AddressStats;
}
