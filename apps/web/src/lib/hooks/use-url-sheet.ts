import { useRef } from "react";

// 抽屉的开合搬进 URL 之后冒出来的一件事 —— 不是抽屉本身的逻辑,而是「状态来自地址栏」带来的
// 适配,所以收在一处,两个页面(首页代币 / 账户)共用。

// 记住最后一个非空值。
//
// **为什么需要**:开合与「显示哪一个」变成了同一个来源 —— `?asset=` 一没,选中项立刻变 null,
// 抽屉内容就在**退场动画播到一半时**空掉,观感是内容先闪没、空壳再滑走。搬进 URL 之前不会:
// 那时 `open` 与 `selected` 是两个 state,关闭只翻 `open`,内容原样留着。
function useLastPresent<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(null);
  // 渲染期写 ref:这个赋值是幂等的(同一个 value 写几次结果一样),被并发渲染丢弃也无副作用。
  if (value != null) last.current = value;
  return last.current;
}

// 抽屉的开合 + 该显示什么。开合直接跟着选中项走;内容滞后一拍,好让退场动画有东西可播。
export function useUrlSheet<T>(selected: T | null): { open: boolean; shown: T | null } {
  return { open: selected != null, shown: useLastPresent(selected) };
}
