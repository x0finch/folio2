import type { Balance } from "@folio/connectors-basic";
import type { Tokens } from "@folio/tokens";

// 同步时重估:仅盯市(mark-to-market)类型用市场价改 value,其余 kind 原样(富化不重算,enrich-not-reprice)。
// 「是否盯市」由 connector 的 manifest.valuation 决定,调用方(sync-deps)解析后以 `markToMarket` 布尔注入 ——
// 不再靠 app 侧硬编码 connectorId 名单,第三方 connector 自带该语义即可(见 @folio/connectors-basic ConnectorValuation)。
// 解析:有 `tokenKey`(用户选币 → coingecko:<id> / BTC → chain:bitcoin/native:btc)→ 直达 ref;否则按 symbol。
// 命中且有价 → value = amount × 市场价,否则保留 provider 的 value(manual 的 amount × unitPrice 回退)。
// 取价/回源/写缓存全在 tokens 内(priceOf),外面只表达意图。只依赖 tokens 实例(无 db/cloudflare)→ 可纯测。
export async function revalue(
  tokens: Tokens,
  markToMarket: boolean,
  balances: Balance[],
): Promise<Balance[]> {
  if (!markToMarket) return balances;
  return Promise.all(
    balances.map(async (b) => {
      const res = await tokens.resolve({ symbol: b.symbol, tokenKey: b.tokenKey }, { lazy: true });
      if (!res.ref) return b;
      const p = await tokens.priceOf(res.ref);
      return p ? { ...b, price: p.unitPrice, value: b.amount * p.unitPrice } : b;
    }),
  );
}
