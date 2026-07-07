// Logo 代理 URL 构造(客户端安全:纯字符串,无 @scure/无 server-only import)。
// 读模型在产 `logo` 时用它把上游 URL 改写成 folio 自己的 `/api/logo/...`,使客户端零引用 CoinGecko
// (隐私:不向 CGK 图片 CDN 泄露持仓)。见 ADR 0008。

// enrich 结果的最小形状(见 @folio/tokens EnrichedAsset)。
interface LogoSource {
  ref: { source: string; identifier: string } | null;
  logo?: string; // canonical(CGK)
  providerLogo?: string; // provider 备用(孤儿)
}

// CGK 源且有 canonical logo → 代理为 `/api/logo/token/<cgkId>`(客户端不再引用 CoinGecko)。
// 其余:孤儿/非 CGK 的 providerLogo 走 provider CDN(非 CoinGecko,不违反"零 CGK"),原样返回;
// 都没有 → undefined(客户端 AvatarFallback 首字母,不发请求)。
export function tokenLogoUrl(e: LogoSource): string | undefined {
  if (e.ref?.source === "coingecko" && e.logo) {
    return `/api/logo/token/${encodeURIComponent(e.ref.identifier)}`;
  }
  return e.logo ?? e.providerLogo;
}
