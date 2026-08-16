// 「一行里最多占 max 格,**计数尾巴自己算一格**」——装得下就全平铺,装不下就前 max-1 个 + `+N`。
// 关键在尾巴占一格:否则 4 个折成 `a b c +1` 比全显还宽,折叠就白折了。
// 账户行的 tag(#a #b +2)与代币抽屉平台行的账户(@a @b +2)共用这一条,两处不会各自漂移。
//
// total 单独传:调用方手里可能只有「前几名」而非全量(如 SourceGroup.topAccounts 只带前 3,
// 真实总数在 count 上),这时按 total 判折叠、按 items 取平铺项。
export function collapseToSlots<T>(
  items: readonly T[],
  max: number | undefined,
  total: number = items.length,
): { shown: T[]; overflow: number } {
  if (max == null || total <= max) return { shown: [...items], overflow: 0 };
  const shown = items.slice(0, max - 1);
  return { shown, overflow: total - shown.length };
}
