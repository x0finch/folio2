import type { SnapshotWithBalances } from "@folio/db";
import { fiatCodeOf, type TokenRecord } from "@folio/oracle-basic";
import type { CredsToken } from "./manual-activity";
import { MANUAL_CONNECTOR_ID } from "./manual-connector";

// 每条 manual 持仓的**展示单价**(USD/单位),与 `tokens` 按序对齐,喂给 `buildManualSnapshot`。
// 缝③ 纯逻辑(无 server/db import → 可单测):server 只负责喂 enrich 结果 + fx 的 resolve + 法币身份映射。
//
// 两条支(身份**按 tokenId 从 `fiatRefs` 判**,不看 `CredsToken.ref`、更不看裸 symbol):
//  · **法币**(`fiatRefs.get(id)` 是白名单 `fiat/issued:<CODE>`,由 `fiatCodeOf` 判定,ADR 0025):
//    价 = FX 汇率(`usd_per_unit`,USD 恒 1),**每次现算不冻价** —— 汇率变则非美元法币的 USD 值随之变,
//    与 mark-to-market 一致。汇率缺(非美元且缓存冷)→ 该项 `undefined` → `buildManualSnapshot` 回退
//    用户自填价,与非法币的降级同一条路(不抛,降级一致)。
//  · **非法币**:现价取 enrich(cache-only)记录的 `unitPrice`;取不到 → `undefined` → 同样回退。
//
// **为什么不看 `CredsToken.ref`(#272 修的真 bug):** 那条 ref 走的是上游命名者(CGK)那一档,法币在该档
// 恒 null(ADR 0021 把它定义成「上游认没认出」),所以 `fiatCodeOf(t.ref)` 对法币永远返回 undefined ——
// #270 的法币分支从不触发,展示价一路回退自填价。法币身份得单独按 `fiat` 命名者取(见 `manualFiatRefs`),
// 经 `fiatRefs`(tokenId → `fiat/issued:<CODE>`)注入进来。
//
// `fxResolve` 由编排层注入(`oracleFor(userId).fx.resolve`),纯逻辑不 new 门面。唯一法币 code 各解
// 一次(`resolve` 是 cache-only、便宜,去重只为省重复 await)。
export async function manualUnitPrices(
  tokens: readonly CredsToken[],
  enriched: ReadonlyMap<string, TokenRecord>,
  fxResolve: (code: string) => Promise<number | undefined>,
  fiatRefs: ReadonlyMap<string, string>,
): Promise<(number | undefined)[]> {
  const fxByCode = new Map<string, Promise<number | undefined>>();
  return Promise.all(
    tokens.map((t) => {
      const fiatRef = fiatRefs.get(t.id);
      const fiatCode = fiatRef ? fiatCodeOf(fiatRef) : undefined;
      if (fiatCode) {
        let p = fxByCode.get(fiatCode);
        if (!p) {
          p = fxResolve(fiatCode);
          fxByCode.set(fiatCode, p);
        }
        return p;
      }
      return Promise.resolve(enriched.get(t.id)?.price?.unitPrice);
    }),
  );
}

// 纯逻辑(缝③,无 server/db import → 可单测)。manual 账户的 creds.tokens(物化投影,= provider 输出)
// → 一份合成 `SnapshotWithBalances`(ADR 0018 做法 1)。manual 不写快照,其「当下」持仓/净值读时现造后
// 注入 `byAccount`,喂给既有装配(overview / history)。
//
// `prices` 与 `tokens` 按序对齐:第 i 项为该 token 的**现价**(USD/单位,cache-only enrich 取)。
// 有现价 → usdValue = amount × 现价(实时盯市,与今天一致);取不到(undefined)→ 回退 amount × unitPrice。
// `selfPrice=null` 保持盯市语义(与 manual 现行为一致)。
// takenAt 仅作占位(UI 对 manual 显「实时」而非同步时间,见 ADR 0018 T2 实施细化);id/snapshotId 为合成占位。
export function buildManualSnapshot(
  accountId: string,
  tokens: CredsToken[],
  prices: (number | undefined)[],
  takenAt: number,
): SnapshotWithBalances {
  const balances = tokens.map((t, i) => {
    const price = prices[i] ?? t.fallbackPrice ?? 0;
    return {
      id: `manual:${accountId}:${i}`,
      snapshotId: `manual:${accountId}`,
      amount: t.amount,
      usdValue: t.amount * price,
      kind: "spot" as const,
      // 手记的持仓不在任何链上 —— 平台是 manual。
      platform: MANUAL_CONNECTOR_ID,
      selfPrice: null,
      // 手记的当下值是**现造的**(ADR 0018:不写快照),但身份不是现造的 —— #203 起手记的币就是
      // `tokens` 里的一行,这个 id 就是那一行。**必须带上**:展示富化 / 预热 / 刷价三个门全按
      // `tokenId` 收口(见 lib/tokens.ts 的同门注),不带就等于这个币不存在 —— 没有上游名字、
      // 没有 logo、也没人去给它取价。显示名(symbol)也从这行的 Token 取,不再随快照合成(#243)。
      tokenId: t.id,
      metaJson: null,
    };
  });
  const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
  return {
    snapshot: { id: `manual:${accountId}`, accountId, takenAt, totalUsd, note: null },
    balances,
  };
}
