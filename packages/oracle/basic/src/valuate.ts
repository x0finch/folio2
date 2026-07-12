// 估值优先级纯函数(oracle 多源,Phase 3)。全站「听谁的价」只此一处判断。
// selfPrice = balance provider(交易所/钱包)自带单价;sourcePrice = 当前活跃行情源单价。
//   · self-first(默认):有自带用自带、无则源补;
//   · source-first(用户开关):有源用源、无则自带兜底;
//   · 两者都无 → 返回 undefined(调用方保留原值,不凭空清零)。
// 纯函数、无 IO,数字即数字(locale 格式化在展示层)。
export type ValuationMode = "self-first" | "source-first";

export function valuate(
  amount: number,
  selfPrice: number | undefined,
  sourcePrice: number | undefined,
  mode: ValuationMode,
): { unitPrice: number; value: number } | undefined {
  const [primary, fallback] =
    mode === "source-first" ? [sourcePrice, selfPrice] : [selfPrice, sourcePrice];
  const unit = primary ?? fallback;
  if (unit == null) return undefined;
  return { unitPrice: unit, value: amount * unit };
}
