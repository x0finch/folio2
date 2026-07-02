import type { AssetRef, TokenInfo, TokenPrice } from "@folio/tokens";

// 纯逻辑(无 server-only import → 可单测)。把一笔余额(快照行形状)桥接到代币参考层:
//   · balanceToAssetRef:kind 门控 + 从 metaJson 抽 chain/contract → AssetRef(喂 tokens.enrich/warm)。
//   · toEnrichment:把缓存查到的 info/price 折成展示富化字段。

export interface BalanceLike {
  symbol: string;
  kind: string;
  metaJson: string | null;
}

export interface TokenEnrichment {
  name?: string;
  logo?: string;
  unitPrice?: number; // USD
  change24h?: number; // 百分比
}

// 只对同质现货解析:spot + manual(按 symbol/合约);defi/perp 不解析(价值/展示走 typed meta)。
export function balanceToAssetRef(b: BalanceLike): AssetRef | null {
  if (b.kind !== "spot" && b.kind !== "manual") return null;
  let chain: string | undefined;
  let contract: string | undefined;
  if (b.metaJson) {
    try {
      const m = JSON.parse(b.metaJson) as Record<string, unknown>;
      if (typeof m.chain === "string") chain = m.chain;
      const c = m.contractAddress ?? m.contract; // coinstats 用 contractAddress;预留 contract
      if (typeof c === "string") contract = c;
    } catch {
      // metaJson 损坏 → 退化为仅 symbol 解析
    }
  }
  return { symbol: b.symbol, chain, contract };
}

export function toEnrichment(info?: TokenInfo, price?: TokenPrice): TokenEnrichment {
  return {
    name: info?.name,
    logo: info?.logo,
    unitPrice: price?.unitPrice,
    change24h: price?.change24h,
  };
}
