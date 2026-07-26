import type { SnapshotWithBalances } from "@folio/db";
import { tokenRef } from "@folio/oracle-ref";
import type { CredsToken } from "./manual-activity";

// 纯逻辑(缝③,无 server/db import → 可单测)。manual 账户的 creds.tokens(物化投影,= provider 输出)
// → 一份合成 `SnapshotWithBalances`(ADR 0018 做法 1)。manual 不写快照,其「当下」持仓/净值读时现造后
// 注入 `byAccount`,喂给既有装配(overview / history)。
//
// `prices` 与 `tokens` 按序对齐:第 i 项为该 token 的**现价**(USD/单位,cache-only enrich 取)。
// 有现价 → usdValue = amount × 现价(实时盯市,与今天一致);取不到(undefined)→ 回退 amount × unitPrice。
// `selfPrice=null` 保持盯市语义(与 manual 现行为一致);identifier → coingecko: tokenRef(与 manualProvider 同源)。
// takenAt 仅作占位(UI 对 manual 显「实时」而非同步时间,见 ADR 0018 T2 实施细化);id/snapshotId 为合成占位。
export function buildManualSnapshot(
  accountId: string,
  tokens: CredsToken[],
  prices: (number | undefined)[],
  takenAt: number,
): SnapshotWithBalances {
  const balances = tokens.map((t, i) => {
    const price = prices[i] ?? t.unitPrice;
    return {
      id: `manual:${accountId}:${i}`,
      snapshotId: `manual:${accountId}`,
      symbol: t.symbol,
      amount: t.amount,
      usdValue: t.amount * price,
      kind: "spot" as const,
      // 手记的持仓不在任何链上 —— 平台是 manual,**不是** ref 左半边的 coingecko。
      platform: "manual",
      selfPrice: null,
      // 与 manual provider 同源:选了币 → `coingecko/<id>`(小写 kebab 归一在生产者侧做),
      // 没选 → `manual/<SYMBOL>`。tokenRef 恒有值(Balance 契约必填)。
      tokenRef: t.identifier
        ? tokenRef.opaque("coingecko", t.identifier.toLowerCase())
        : tokenRef.opaque("manual", t.symbol.trim().toUpperCase()),
      // 手记的当下值是**现造的**(ADR 0018:不写快照),所以没有落库时 mint 出来的 token_id。
      // 读端遇到空 token_id 会退回 tokenRef 那条路。手记并入 tokens 是 #203 的事。
      tokenId: null,
      metaJson: null,
    };
  });
  const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
  return {
    snapshot: { id: `manual:${accountId}`, accountId, takenAt, totalUsd, note: null },
    balances,
  };
}
