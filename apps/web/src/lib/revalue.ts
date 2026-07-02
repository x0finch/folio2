import type { AccountType, Balance } from "@folio/core";
import { type CoinId, PRICE_TTL_MS, refKey, type TokenRef, type Tokens } from "@folio/tokens";

// 同步时重估(P7.4.2/P7.4.3):仅 manual 用市场价改 usdValue,其余 kind 原样(富化不重算)。
// 解析:有 `meta.coinId`(用户选币,P7.4.3)→ 显式 ref;否则按 symbol。命中且有价 → usdValue = amount × 市场价,
// 否则保留 provider 的 amount × unitPrice(回退价)。缓存缺价 → provider.fetchPrices 取一次(选中的长尾币也能估值)。
// 只依赖 tokens 实例(无 db/cloudflare)→ 可纯测。
export async function revalueManual(
  tokens: Tokens,
  accountType: AccountType,
  balances: Balance[],
): Promise<Balance[]> {
  if (accountType !== "manual") return balances;
  await tokens.refreshWarm({ now: Date.now() }); // TTL 门控,只首个真拉
  return Promise.all(
    balances.map(async (b) => {
      // 锁定固定值(P7.4.4):即便币可识别也跳过市价、保留 provider 的 amount × unitPrice。
      if (b.meta?.fixed) return b;
      const coinId = typeof b.meta?.coinId === "string" ? b.meta.coinId : undefined;
      const explicit: TokenRef | undefined = coinId
        ? { source: tokens.provider.source, coinId: coinId as CoinId }
        : undefined;
      const res = await tokens.resolveAsset({ symbol: b.symbol, ref: explicit }, { lazy: true });
      if (!res.ref) return b;
      let price = (await tokens.store.getPrices([res.ref])).get(refKey(res.ref));
      if (!price) {
        // 选中的币不在 warm top-N → 直接取一次该 ref 的价并缓存。
        price = (await tokens.provider.fetchPrices([res.ref])).get(refKey(res.ref));
        if (price) await tokens.store.putPrices([price], PRICE_TTL_MS);
      }
      return price ? { ...b, usdValue: b.amount * price.unitPrice } : b;
    }),
  );
}
