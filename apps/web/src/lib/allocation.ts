import type { Holding } from "./aggregate";

// 分配 rollup(Insights):把 Holdings 按维度切成饼图切片。三维都从 holdings/sources 派生,
// 故都汇总到 holdings 小计(彼此一致):
//   token   —— 每个 Holding(按代币)
//   chain   —— 各 HoldingSource 的 platform(链/交易所/perp/manual,即"在哪")
//   account —— 各 HoldingSource 的账户
// 超过 topN 的尾部合并成一条 key="__others__"(UI 渲染为"其他")。纯函数、可测。
export type AllocDimension = "token" | "chain" | "account";
export interface AllocSlice {
  key: string;
  label: string;
  value: number;
}
export const OTHERS_KEY = "__others__";

export function buildAllocation(
  holdings: readonly Holding[],
  dim: AllocDimension,
  topN = 8,
): AllocSlice[] {
  const map = new Map<string, { label: string; value: number }>();
  const add = (key: string, label: string, value: number) => {
    const e = map.get(key);
    if (e) e.value += value;
    else map.set(key, { label, value });
  };
  for (const h of holdings) {
    if (dim === "token") {
      add(h.key, h.token.symbol, h.totalValue);
    } else {
      for (const s of h.sources) {
        if (dim === "chain") add(s.platform.id, s.platform.name, s.value);
        else add(s.account.id, s.account.label, s.value);
      }
    }
  }
  const slices = [...map.entries()]
    .map(([key, v]) => ({ key, label: v.label, value: v.value }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  if (slices.length <= topN) return slices;
  const top = slices.slice(0, topN);
  const othersValue = slices.slice(topN).reduce((s, x) => s + x.value, 0);
  top.push({ key: OTHERS_KEY, label: OTHERS_KEY, value: othersValue });
  return top;
}
