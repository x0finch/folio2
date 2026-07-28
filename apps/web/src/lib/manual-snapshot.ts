import type { SnapshotWithBalances } from "@folio/db";
import { tokenRef } from "@folio/oracle-ref";
import type { CredsToken } from "./manual-activity";
import { MANUAL_CONNECTOR_ID } from "./manual-connector";

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
    const price = prices[i] ?? t.unitPrice;
    return {
      id: `manual:${accountId}:${i}`,
      snapshotId: `manual:${accountId}`,
      symbol: t.symbol,
      amount: t.amount,
      usdValue: t.amount * price,
      kind: "spot" as const,
      // 手记的持仓不在任何链上 —— 平台是 manual,**不是** ref 左半边的 coingecko。
      platform: MANUAL_CONNECTOR_ID,
      selfPrice: null,
      // 选了币 → db 给的那条 ref **原样搬**(上游是谁、它的 id 长什么样,本文件不需要知道);
      // 没选 → `manual/custom:<名字>`,手记自己就是命名者,而这个名字没有注册表背书
      // (见 manual-connector.ts)。tokenRef 恒有值(Balance 契约必填)。
      tokenRef: t.ref ?? tokenRef.custom(MANUAL_CONNECTOR_ID, t.symbol),
      // 手记的当下值是**现造的**(ADR 0018:不写快照),但身份不是现造的 —— #203 起手记的币就是
      // `tokens` 里的一行,这个 id 就是那一行。**必须带上**:展示富化 / 预热 / 刷价三个门全按
      // `tokenId` 收口(见 lib/tokens.ts 的同门注),不带就等于这个币不存在 —— 没有上游名字、
      // 没有 logo、也没人去给它取价,而库里那行会一直停在连接器报的那份元信息上。
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
