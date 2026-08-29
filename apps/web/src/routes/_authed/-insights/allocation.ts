import { z } from "zod";
import type { Holding } from "@/lib/core/portfolio";

// 分配 rollup(Insights):把 Holdings 按维度切成饼图切片。三维都从 holdings/sources 派生,
// 故都汇总到 holdings 小计(彼此一致):
//   token   —— 每个 Holding(按代币)
//   chain   —— 各 HoldingSource 的 platform(链/交易所/perp/manual,即"在哪")
//   account —— 各 HoldingSource 的账户
// 超过 topN 的尾部合并成一条 key="__others__"(UI 渲染为"其他")。纯函数、可测。
// 维度的合法值**只在这里写一次**,类型由它派生(`z.infer`)—— 不是类型和数组各写一遍再想办法
// 让两者对上。这也是 Insights 那个 `?dim=` 的校验器本体:route 直接把它交给 `validateSearch`
// (zod v4 是 Standard Schema,Router 不需要 adapter),`.catch()` 就是「认不出的值回落默认」。
export const ALLOC_DIMENSION = z.enum(["token", "chain", "account"]);
export type AllocDimension = z.infer<typeof ALLOC_DIMENSION>;
// tab 条按这个顺序渲染。`.options` 直接来自上面那份声明 —— 将来多一个维度,tab 条不可能漏掉它。
export const ALLOC_DIMENSIONS = ALLOC_DIMENSION.options;
export const DEFAULT_DIM: AllocDimension = "token";
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
