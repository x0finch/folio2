import { getRouteApi } from "@tanstack/react-router";
import { useRef } from "react";
import {
  DEFAULT_TAB,
  KIND_TABS,
  type KindTab,
  pickShownTab,
} from "@/routes/_authed/-home/home-tabs";

const home = getRouteApi("/_authed/");

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
  // **住在 URL 里**(ADR 0043):刷新回原 tab、链接可分享,每个 tab 各记自己的滚动位置。
  const { tab } = home.useSearch();
  const navigate = home.useNavigate();
  const active = tab ?? DEFAULT_TAB;
  // `replace` 而不是 push:iOS/Android 的原生约定都是 tab 切换**不进**后退栈,否则系统返回键
  // 变成「倒放我刚点过的每一下」。默认 tab 写成 `undefined` → 从 URL 里去掉,不留 `?tab=tokens`。
  //
  // 切到自定义 Tab 会挂起(那份数据按 pin 另拉一遍),以前靠 `startTransition` 包着才不闪骨架 ——
  // 现在不用了:router 的所有导航本来就跑在 React transition 里(`Transitioner` 把
  // `router.startTransition` 换成了 `React.startTransition`,`Link` 上那个同名 prop 因此被标了废弃)。
  //
  // `resetScroll: false` 是**必须的**:router 的 scrollRestoration 把 `?tab=` 变化当成一个新地址,
  // 新地址没有滚动记录 → 主动 `scrollTo({top:0})`(调用点抓到过)。实测滚到 y=600 点一下 tab,画面
  // 自己弹回顶部,观感就是「整页刷新了一下」;而 tab 条本身在页面中段,弹到顶等于把刚点的东西顶出视野。
  //
  // 换内容那一下**高度还是会塌**、滚动位置被浏览器夹掉,是**另一件事**(main 上就有,与 tab 进不进
  // URL 无关)。成因是「panel 被卸载 + 所有 tab 共用一个滚动区」,原生 tab 两条都不是这样 —— 治法
  // (panel 常驻 `<Activity>` + 每个 tab 自己的滚动容器)见 #483,不在这一片里凑合。
  const selectTab = (v: string) => {
    if (v === active) return; // 值没变就别导航
    // 默认 tab 不必在这里抹成 undefined —— `stripSearchParams` 中间件在建地址时统一剥掉。
    navigate({
      search: (prev) => ({ ...prev, tab: v }),
      replace: true,
      resetScroll: false,
    });
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
