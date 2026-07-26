import type { AssetRef, EnrichedAsset } from "@folio/oracle";
import { isFungible, viewKind } from "./balance-kind";
import { tokenLogoUrl } from "./logo";

// 纯逻辑(无 server-only import → 可单测)。把一笔余额(快照行形状)桥接到代币参考层:
//   · balanceToAssetRef:kind 门控 + 从 metaJson 抽 chain/contract → AssetRef(喂 tokens.enrich/warm)。
//   · toEnrichment:把富化结果折成展示字段(logo 回退链:CGK → provider 备用 → 无)。

export interface BalanceLike {
  symbol: string;
  kind: string;
  tokenRef?: string | null; // 快照持久化的 CAIP-19 标识(解析 tokenRef;CEX/manual/原生为空)
  platform?: string | null; // 这笔持仓所在的链 ∪ 场馆(provider 直接报,#193)
}

export interface TokenEnrichment {
  name?: string;
  logo?: string;
  unitPrice?: number; // USD
  change24h?: number; // 百分比
  marketCapRank?: number; // 市值排名(展示用)
}

// 只对同质持仓解析:现货 + UTXO(BTC)(按 symbol/标识);defi/perp 不解析(价值/展示走 typed meta)。
// kind 走 viewKind 归一(并存期兼容遗留 manual→spot、bitcoin→utxo)。
// 解析直接用持久化的 tokenRef(provider 构造,含 chainId → 懒解析更准);无则仅 symbol。
export function balanceToAssetRef(b: BalanceLike): AssetRef | null {
  if (!isFungible(viewKind(b))) return null;
  return { symbol: b.symbol, tokenRef: b.tokenRef ?? undefined };
}

// defi 行的**展示用**解析(H5 #120:协议行 24h 聚合需要 change24h):仅 tokenRef 明确的行
// (LP 份额等无 tokenRef 的头寸不按 symbol 瞎猜)。独立于 balanceToAssetRef —— 那个门喂估值
// 现推(liveValue),defi 行进去会被重估;这个只喂展示富化。
export function defiAssetRef(b: BalanceLike): AssetRef | null {
  if (viewKind(b) !== "defi" || !b.tokenRef) return null;
  return { symbol: b.symbol, tokenRef: b.tokenRef };
}

// **展示富化的统一门**(同质 ∪ tokenRef 明确的 defi)。enrich / refreshStalePrices / warmTokens
// 三处必须同门:enrich 标了 stale 而 refresh/warm 够不到的行会让 pricesStale 永远清不掉、
// 客户端每次加载空转一次刷新(code review #2)。估值现推(liveValue)不走此门,仍只认
// balanceToAssetRef 的同质行。
export function displayAssetRef(b: BalanceLike): AssetRef | null {
  return balanceToAssetRef(b) ?? defiAssetRef(b);
}

// logo 优先 CGK(视觉统一,warm 缓存零边际配额),缺则回退 provider 自带图(备用槽);
// CGK 未收录的孤儿也有 name/providerLogo 可显(不再是裸 symbol+首字母)。
export function toEnrichment(e: EnrichedAsset): TokenEnrichment {
  return {
    name: e.name,
    logo: tokenLogoUrl(e), // 上游 URL → folio 代理(隐私;见 ADR 0008)
    unitPrice: e.unitPrice,
    change24h: e.change24h,
    marketCapRank: e.marketCapRank,
  };
}
