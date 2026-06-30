import type { AccountType, Balance } from "@folio/core";
import { type ResolveDeps, refKey, refreshWarm, resolveAsset } from "@folio/tokens";

// 同步时重估(P7.4.2):仅 manual 用市场价改 usdValue,其余 kind 原样(富化不重算)。
// manual 按 symbol 解析(无 chain/contract);命中且有价 → usdValue = amount × 市场价,否则保留
// provider 的 amount × unitPrice(回退价)。注入到 SyncDeps.revalue(@folio/sync 写快照前调)。
// 只依赖 token 层接口(无 db/cloudflare 导入)→ 可纯测。
export async function revalueManual(
  deps: ResolveDeps,
  accountType: AccountType,
  balances: Balance[],
): Promise<Balance[]> {
  if (accountType !== "manual") return balances;
  await refreshWarm(deps, { now: Date.now() }); // TTL 门控,只首个真拉
  return Promise.all(
    balances.map(async (b) => {
      const res = await resolveAsset({ symbol: b.symbol }, deps, { lazy: true });
      if (!res.ref) return b;
      const price = (await deps.store.getPrices([res.ref])).get(refKey(res.ref));
      return price ? { ...b, usdValue: b.amount * price.unitPrice } : b;
    }),
  );
}
