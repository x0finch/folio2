import type { AccountType, Balance } from "@folio/core";
import type { Tokens } from "@folio/tokens";

// 同步时重估(P7.4.2/P7.4.3):仅 manual 用市场价改 usdValue,其余 kind 原样(富化不重算)。
// 解析:有 `meta.coinId`(用户选币,P7.4.3)→ 显式 ref;否则按 symbol。命中且有价 → usdValue = amount × 市场价,
// 否则保留 provider 的 amount × unitPrice(回退价)。取价/回源/写缓存全在 tokens 内(priceOf),外面只表达意图。
// 只依赖 tokens 实例(无 db/cloudflare)→ 可纯测。
export async function revalueManual(
  tokens: Tokens,
  accountType: AccountType,
  balances: Balance[],
): Promise<Balance[]> {
  if (accountType !== "manual") return balances;
  return Promise.all(
    balances.map(async (b) => {
      // 锁定固定值(P7.4.4):即便币可识别也跳过市价、保留 provider 的 amount × unitPrice。
      if (b.meta?.fixed) return b;
      const coinId = typeof b.meta?.coinId === "string" ? b.meta.coinId : undefined;
      const res = await tokens.resolve({ symbol: b.symbol, coinId }, { lazy: true });
      if (!res.ref) return b;
      const price = await tokens.priceOf(res.ref);
      return price ? { ...b, usdValue: b.amount * price.unitPrice } : b;
    }),
  );
}
