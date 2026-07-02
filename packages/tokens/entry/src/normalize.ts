// tokens 层统一的 key 归一口径。store 分桶/查键一律用这里的归一结果 —— store 自身不做归一,
// 调用方(service)在写/查 store 前经这些函数处理,保证存与查同口径。集中一处,避免散落。

export const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase();
export const normalizeChain = (chain: string): string => chain.trim().toLowerCase();
export const normalizeContract = (contract: string): string => contract.trim().toLowerCase();
