import { parseTokenRef, type TokenRef, tokenRef } from "@folio/oracle-ref";

// 行情厂商作为**命名者**(ADR 0020):CoinGecko 管某个币叫 `coingecko/usd-coin`。
// 参考层的「解析结果」就是这条串,不再有第二种序列化。
export const CGK_VENDOR = "coingecko";

// 造:上游 id → tokenRef。CGK coin id 规范为小写 kebab,归一在此(生产者侧)做。
export const cgkRef = (id: string): TokenRef => tokenRef.local(CGK_VENDOR, id.toLowerCase());

// 取:tokenRef → 某厂商的上游 id。不是该厂商的命名(链上寻址、别家 vendor)→ undefined。
// 存储层按 (vendor, vendorId) 两列存映射,故写库前要用它把串拆回上游 id。
export function vendorIdOf(ref: TokenRef, vendor: string): string | undefined {
  const parsed = parseTokenRef(ref);
  return parsed.kind === "local" && parsed.namer === vendor ? parsed.localName : undefined;
}

// 拆:tokenRef → 存储层的两列 (vendor, vendorId)。`token_vendor_ids` 与 `token_price_history`
// 都按这两列存,故写库前要拆。读不懂的串(非两段)/ 原生币 → undefined,调用方据此跳过。
// 注:文法收窄后本函数**无从分辨**厂商命名与链上寻址(`evm:1/0xabc` 也会拆成两段)——
// 唯一的调用方 price-history-store 由 `priceSeries` 的 `vendorIdOf(ref, source)` 前置守卫,
// 只会拿到本源命名的 ref。这条守卫在 oracle2 里由 `tokens.id` 取代(#198)。
export function vendorPartsOf(ref: TokenRef): { vendor: string; vendorId: string } | undefined {
  const parsed = parseTokenRef(ref);
  return parsed.kind === "local" ? { vendor: parsed.namer, vendorId: parsed.localName } : undefined;
}
