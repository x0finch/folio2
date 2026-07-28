import type { Tokens as LegacyTokens } from "@folio/oracle";
import type { Tokens } from "@folio/oracle2";
import {
  type BalanceLike,
  displayTokenId,
  displayTokenIds,
  type TokenEnrichment,
  toEnrichment,
} from "../../tokens";

// 代币展示富化 / 预热助手(非 server fn,server-only)。被 portfolio / sync-deps 复用。

// 展示富化(cache-only,零网络):**按 token_id 批量读整行**,按行挂富化字段(缺则原样降级)。
// 认定在写快照时已定死(ADR 0021 / #201),这里不再解析身份,也不再靠下标与返回数组配对 ——
// 后者是个长期的 locality 隐患(克隆或过滤一步就全错位)。
//
// 上游还没认出来的币也出 name/providerLogo(不再是裸 symbol + 首字母)。
export async function enrichBalances<T extends BalanceLike>(
  tokens: Tokens,
  balances: T[],
): Promise<{ rows: (T & TokenEnrichment)[]; pricesStale: boolean }> {
  // defi 行也做展示富化(H5 #120:抽屉协议行的 24h 聚合);估值现推路径不受影响
  // (那里仍只走 fungibleTokenId 的同质门)。
  const enriched = await tokens.enrich(displayTokenIds(balances));
  let pricesStale = false;
  const rows = balances.map((b) => {
    const id = displayTokenId(b);
    if (!id) return b; // 没有身份的行不参与富化,也不算 stale(刷了也没用)
    const e = enriched.get(id);
    // stale = 过期**或压根没有价**。新层刚 mint 出的行正是「有身份、无价」,必须让客户端来刷一次,
    // 否则首屏永远没价而且没人去取(pricesStale 与 refreshStalePrices 必须同门,code review #2)。
    //
    // **但只算「刷得出来」的行**:`ref` 空 = 上游还没认出它(手记里自己敲名字的币恒是这样),
    // 刷价那一侧本来就会跳过它(见 refreshStalePrices:只刷 ref 非空的),所以标脏只会换来
    // 每次进页白发一次请求、而且永远清不掉。这与上面那句「没有身份的行不算 stale」是同一条理由。
    if (e?.ref && e.price?.stale !== false) pricesStale = true;
    return e ? { ...b, ...toEnrichment(e) } : b;
  });
  return { rows, pricesStale };
}

// 预热(写缓存,best-effort):刷新 top-N + 逐行懒解析(合约懒解析入缓存)。
// cron(waitUntil)与手动 sync 后调用。
//
// **仍走旧参考层** —— 预热属于写路径,连同 revalue 与手记一起在 #202 / #203 切过去。
// 旧的 `warm` 收 `AssetRef`(symbol + tokenRef),所以这里就地拼:lib/tokens 那几个门已经全部
// 改成返回 token_id,借不到了。
export async function warmTokens(tokens: LegacyTokens, balances: BalanceLike[]): Promise<void> {
  await tokens.warm(
    balances.map((b) => (b.tokenRef ? { symbol: b.symbol, tokenRef: b.tokenRef } : null)),
  );
}
