import { type MotionValue, motionValue } from "motion/react";
import { createContext, type ReactNode, useContext } from "react";

// 抽屉「上滑了多少」这一个数,给外壳用来同步缩放(片9 / ADR 0041)。
// 0 = 完全收起(不缩放),1 = 顶格(缩到最小)。
//
// **为什么是一个共享的动画值而不是 state**:抽屉 portal 到 `<body>`,外壳在 React 树里离它很远;
// 而这个数每帧都在变。走 state 会让整棵树每帧重渲染;走 CSS 变量则要每帧用 JS 写样式、触发重算。
// motion value 是「值变了只通知订阅者」的那条路 —— 外壳订阅它、只改自己那一层 transform。
//
// 缺省值是一个模块级的常量 motion value:没有 Provider(登录页 / 锁屏)时读它恒为 0,
// 调用方不用判空。
const IDLE_PROGRESS = motionValue(0);

const SheetProgressContext = createContext<MotionValue<number>>(IDLE_PROGRESS);

export function SheetProgressProvider({
  progress,
  children,
}: {
  progress: MotionValue<number>;
  children: ReactNode;
}) {
  return <SheetProgressContext.Provider value={progress}>{children}</SheetProgressContext.Provider>;
}

export function useSheetProgress(): MotionValue<number> {
  return useContext(SheetProgressContext);
}
