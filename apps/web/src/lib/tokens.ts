import type { TokenRecord } from "@folio/oracle";
import { isFungible, viewKind } from "./balance-kind";
import { tokenLogoUrl } from "./logo";

// 纯逻辑(无 server-only import → 可单测)。把一笔余额(快照行形状)桥接到代币参考层。
//
// **读端不再解析身份**(ADR 0021 / #201):认定在写快照时由 mint 定死,余额行自己带着 `token_id`。
// 下面三个门只回答「这一行参不参与」,答案就是它的 token_id 或 null —— 以前它们要造 `AssetRef`
// (symbol + tokenRef)交给参考层现场解析,那一步整个消失了。

export interface BalanceLike {
  symbol: string;
  kind: string;
  // 写快照时 mint 定死的代币行 id。可空:本列之前写下的旧快照、以及手记那种现造的持仓(#203)。
  tokenId?: string | null;
  tokenRef?: string | null; // 旧列,写路径仍在写;#202 删
  platform?: string | null; // 这笔持仓所在的链 ∪ 场馆(provider 直接报,#193)
}

export interface TokenEnrichment {
  name?: string;
  logo?: string;
  unitPrice?: number; // USD
  change24h?: number; // 百分比
  marketCapRank?: number; // 市值排名(展示用)
}

// 只对同质持仓取价:现货 + UTXO(BTC);defi/perp 不取(价值/展示走 typed meta)。
// kind 走 viewKind 归一(并存期兼容遗留 manual→spot、bitcoin→utxo)。
export function fungibleTokenId(b: BalanceLike): string | null {
  if (!isFungible(viewKind(b))) return null;
  return b.tokenId ?? null;
}

// defi 行的**展示用**身份(H5 #120:协议行 24h 聚合需要 change24h)。独立于 fungibleTokenId ——
// 那个门喂估值现推(liveValue),defi 行进去会被重估;这个只喂展示富化。
export function defiTokenId(b: BalanceLike): string | null {
  if (viewKind(b) !== "defi") return null;
  return b.tokenId ?? null;
}

// **展示富化的统一门**(同质 ∪ defi)。enrich / refreshStalePrices / warm 三处必须同门:
// enrich 标了 stale 而 refresh 够不到的行会让 pricesStale 永远清不掉、客户端每次加载空转一次刷新
// (code review #2)。估值现推(liveValue)不走此门,仍只认 fungibleTokenId 的同质行。
export function displayTokenId(b: BalanceLike): string | null {
  return fungibleTokenId(b) ?? defiTokenId(b);
}

// 一批余额行 → 去重后的 token_id 列表(喂 enrich / refreshStalePrices)。
export function displayTokenIds(rows: readonly BalanceLike[]): string[] {
  return [
    ...new Set(rows.flatMap((b) => (displayTokenId(b) ? [displayTokenId(b) as string] : []))),
  ];
}

// logo 优先源给的那张(视觉统一,warm 缓存零边际配额),缺则回退连接器自带图(备用槽);
// 上游还没认出来的币也有 name/providerLogo 可显(不再是裸 symbol + 首字母)。
export function toEnrichment(e: TokenRecord): TokenEnrichment {
  return {
    name: e.name,
    logo: tokenLogoUrl(e), // 上游 URL → folio 代理(隐私;见 ADR 0008)
    unitPrice: e.price?.unitPrice,
    change24h: e.price?.change24h,
    marketCapRank: e.price?.marketCapRank,
  };
}
