import { useRef } from "react";
import {
  DEFAULT_TAB,
  KIND_TABS,
  type KindTab,
  pickShownTab,
} from "@/routes/_authed/-home/home-tabs";
import { useHomeViewState } from "@/routes/_authed/-home/view-state";

const TAB_SCROLL_MARGIN = 16; // 选中 tab 滚进可视区时两侧留的余量(px)

// 把 tab(或 ＋)在横向滚动的 tab 条里滚到完全可见(两侧留余量)。手写而非 scrollIntoView:
// 后者会连带滚 overflow-hidden 祖先和页面纵向(实测踩坑)。
export function revealTab(el: HTMLElement) {
  const strip = el.closest(".overflow-x-auto");
  if (!strip) return;
  const sr = strip.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (er.right + TAB_SCROLL_MARGIN > sr.right)
    strip.scrollLeft += er.right + TAB_SCROLL_MARGIN - sr.right;
  else if (er.left - TAB_SCROLL_MARGIN < sr.left)
    strip.scrollLeft -= sr.left - er.left + TAB_SCROLL_MARGIN;
}

export function useHomeTabSelection(pins: { id: string }[]) {
  // 单一 tab 状态:"tokens" / "perps" / "defi"(视角)或 pin id(自定义 Tab)。默认 tokens。
  // **住组件内部 state**(FOL-80,反转 ADR 0043):以前住 URL,现在由 `HomeViewStateProvider` 持有;
  // 一个路由 + `<Activity>` 保活之后,切走再回来由 Activity 留着,不再靠 `?tab=` 记。
  const { tab: active, setTab } = useHomeViewState();
  // 值没变就别写(与原来的 `if (v === active) return` 同义)。切到自定义 Tab 会挂起(那份数据按 pin
  // 另拉一遍),交给上层 Suspense 边界兜,不必手动 `startTransition`。滚动/后退栈的老问题一并消失:
  // 不再是一次导航,只是一次 setState —— scrollRestoration 不介入,也不进后退栈。
  const selectTab = (v: string) => {
    if (v === active) return;
    setTab(v);
  };
  // active 可能短暂指向「还没挂上的 pin」—— 建 pin 后即便 await 了 invalidate,它 resolve 的时刻
  // 与新数据在组件里可见之间仍有空窗(实测)。渲染用最后一个仍有效的值,新 tab 挂上自动切过去,
  // 药丸/内容不闪回 Tokens。
  // tab 进 URL 之后这段**同时**兼了另一件事:`?tab=` 指向一个不存在的 pin(被删了、或手写乱码)时
  // 回落到默认 tab —— 不空白、不报错。URL 上那个死值**故意不清掉**:清它就得区分「这个 pin 不存在」
  // 与「这个 pin 还没挂上」,而后者正是上面那段存在的理由。
  const isKnownTab = (v: string) =>
    KIND_TABS.includes(v as KindTab) || pins.some((p) => p.id === v);
  const lastKnownActive = useRef<string>(DEFAULT_TAB);
  if (isKnownTab(active)) lastKnownActive.current = active;
  const shownActive = pickShownTab(active, lastKnownActive.current, isKnownTab);
  return { active, selectTab, shownActive };
}
