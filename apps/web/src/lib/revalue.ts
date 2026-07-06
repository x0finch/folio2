import type { AccountType, Balance } from "@folio/balances";
import type { Tokens } from "@folio/tokens";

// 同步时按市价盯市(mark-to-market)的账户类型:provider 只给 amount、value 交这里算的那些。
//   · manual —— 用户录数量,市价改 value(P7.4.2/P7.4.3);
//   · onchain_bitcoin —— provider 只产已确认 BTC amount(value=0),此处 amount × BTC 市价。
// 其余(zerion/CEX/perp 自带 USD 估值)不动:富化不重算(enrich-not-reprice)。
const REVALUE_TYPES = new Set<AccountType>(["manual", "onchain_bitcoin"]);

// 同步时重估:仅盯市类型用市场价改 value,其余 kind 原样。
// 解析:有 `tokenKey`(用户选币 → coingecko:<id> / BTC → chain:bitcoin/native:btc)→ 直达 ref;否则按 symbol。
// 命中且有价 → value = amount × 市场价,否则保留 provider 的 value(manual 的 amount × unitPrice 回退)。
// 取价/回源/写缓存全在 tokens 内(priceOf),外面只表达意图。只依赖 tokens 实例(无 db/cloudflare)→ 可纯测。
export async function revalue(
  tokens: Tokens,
  accountType: AccountType,
  balances: Balance[],
): Promise<Balance[]> {
  if (!REVALUE_TYPES.has(accountType)) return balances;
  return Promise.all(
    balances.map(async (b) => {
      // 锁定固定值(P7.4.4):即便币可识别也跳过市价、保留 provider 的 amount × unitPrice。
      if (b.meta?.fixed) return b;
      const res = await tokens.resolve({ symbol: b.symbol, tokenKey: b.tokenKey }, { lazy: true });
      if (!res.ref) return b;
      const p = await tokens.priceOf(res.ref);
      return p ? { ...b, price: p.unitPrice, value: b.amount * p.unitPrice } : b;
    }),
  );
}
