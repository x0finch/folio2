import type { AssetRef, EnrichedAsset } from "@folio/tokens";

// 纯逻辑(无 server-only import → 可单测)。把一笔余额(快照行形状)桥接到代币参考层:
//   · balanceToAssetRef:kind 门控 + 从 metaJson 抽 chain/contract → AssetRef(喂 tokens.enrich/warm)。
//   · toEnrichment:把富化结果折成展示字段(logo 回退链:CGK → provider 备用 → 无)。

export interface BalanceLike {
  symbol: string;
  kind: string;
  tokenKey?: string | null; // 快照持久化的 CAIP-19 标识(解析 tokenKey;CEX/manual/原生为空)
}

export interface TokenEnrichment {
  name?: string;
  logo?: string;
  unitPrice?: number; // USD
  change24h?: number; // 百分比
}

// 只对同质现货解析:spot + manual(按 symbol/标识);defi/perp 不解析(价值/展示走 typed meta)。
// 解析直接用持久化的 tokenKey(provider 构造,含 chainId → 懒解析更准);无则仅 symbol。
export function balanceToAssetRef(b: BalanceLike): AssetRef | null {
  if (b.kind !== "spot" && b.kind !== "manual") return null;
  return { symbol: b.symbol, tokenKey: b.tokenKey ?? undefined };
}

// logo 优先 CGK(视觉统一,warm 缓存零边际配额),缺则回退 provider 自带图(备用槽);
// CGK 未收录的孤儿也有 name/providerLogo 可显(不再是裸 symbol+首字母)。
export function toEnrichment(e: EnrichedAsset): TokenEnrichment {
  return {
    name: e.name,
    logo: e.logo ?? e.providerLogo,
    unitPrice: e.unitPrice,
    change24h: e.change24h,
  };
}
