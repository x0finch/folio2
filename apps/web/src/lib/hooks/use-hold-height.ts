import { useEffect, useRef } from "react";

// 换页内 tab 时,把容器的高度先撑住,等新内容落地再放开。
//
// **为什么需要**:切 tab 会把旧内容整块换掉,换的过程中页面高度会瞬间塌下来 —— 浏览器一旦在那一刻量了
// 布局,就会把页面滚动位置**夹**到当时的最大可滚动量(内容没了 → 夹到 0),等新内容撑起来滚动位置也不会
// 自己回去。观感就是「点一下 tab,整页刷新了一下」。
//
// 实测(dev,首页 Tokens→Perps,滚到 y=700):
//   - 什么都不做 → y 变 0。没有任何 `scrollTo`/`scrollTop` 被调用(全都下过钩子),html/body 的
//     `overflow` 没变过,DOM 也没重挂 —— 所以不是谁把它滚回去的,是**高度塌了被夹的**。
//   - 换 tab 前把容器 `min-height` 钉在当时的高度 → y 保持 700。
// 这条与 router 的 `resetScroll` 是**两件事**:那个是 TanStack 主动 `scrollTo({top:0})`(调用点抓到过),
// 只在导航时发生;这个连本地 state 切 tab 也有,main 上就存在,与 tab 进不进 URL 无关。
//
// 放开的时机是「新内容渲染完那一次 effect」,不是固定几帧:dev 下这一整段要 ~270ms,按帧数放开会赶在
// 内容落地之前,等于没撑。撑住期间页面只是**底部多一段空白**,一帧后消失。
export function useHoldHeight(settledKey: string) {
  const ref = useRef<HTMLDivElement>(null);

  // 调用点:**只在真的要换 tab 时**调 —— 值没变就不会有新的一轮渲染,下面那个 effect 也就不跑,
  // 撑住的高度会一直留着。
  const hold = () => {
    const el = ref.current;
    if (el) el.style.minHeight = `${el.offsetHeight}px`;
  };

  // `settledKey` 在 effect 体里确实没被读 —— 它是**触发器**:key 一变就说明新内容那一轮渲染完了,
  // 这次 effect 就是放开高度的时机。规则只看「体里用没用到」,所以这里得明说别删。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖是重跑的触发器,不是被读取的值
  useEffect(() => {
    const el = ref.current;
    if (el) el.style.minHeight = "";
  }, [settledKey]);

  return { ref, hold } as const;
}
