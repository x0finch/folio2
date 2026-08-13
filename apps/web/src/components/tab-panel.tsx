import { EASE_OUT } from "@folio/ui/lib/ease";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

// 页内 tab 切换时给内容一层克制的转场(片6):两个布局差别很大的 tab 之间不再硬切一下。
//
// **只动 opacity,一点位移都不加** —— 不是偷懒,是避开一个这仓踩过的坑:任何非 none 的 transform
// 都让该元素成为 fixed 后代的包含块,而且 motion 在动画结束后未必把 transform 清成 `none`
// (常留一个 `translateY(0px)`)。内容里有 `sticky` 的浮动 chip(token-holdings)与经 Portal 浮出的
// 弹层,包一层常驻 transform 就有让它们错位的风险。纯淡入淡出没有这一类风险,而原生 tab bar
// 切内容本来也不滑 —— 观感上并不吃亏。
//
// **为什么不用 View Transitions API**:它给**整页**做快照,而外壳里有两处 shared-layout 动画
// (底部 Dock 的药丸、桌面侧栏的滑块)—— 两套机制会打架(药丸闪一下 / 位置跳)。这一层只包 tab 面板,
// 结构上就碰不到外壳,那个风险直接不存在,不需要靠真机去赌。四个导航 tab 之间照旧无转场(原生约定)。
const OUT_SECONDS = 0.1;
const IN_SECONDS = 0.16;

export function TabPanel({ tabKey, children }: { tabKey: string; children: ReactNode }) {
  const reduce = useReducedMotion() ?? false;
  // 减少动态效果:整层跳过 —— 不是「淡得慢一点」,是压根不包。
  if (reduce) return <>{children}</>;

  return (
    // mode="wait":先让旧面板淡出、再淡入新的。两个面板同时在场会撑出双份高度、页面抖一下。
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={tabKey}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: IN_SECONDS, ease: EASE_OUT } }}
        exit={{ opacity: 0, transition: { duration: OUT_SECONDS, ease: EASE_OUT } }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
