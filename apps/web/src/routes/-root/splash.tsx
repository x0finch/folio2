import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { Logo } from "@/components/logo";
import { useSplashUpdating } from "@/lib/pwa/service-worker";
import {
  SPLASH_EXIT_MS,
  SPLASH_MAX_MS,
  SPLASH_MIN_MS,
  type SplashPhase,
  splashPhase,
} from "./splash-lifecycle";

// 冷启动闪屏(ADR 0051)。覆盖层由 SSR shell 渲染、盖住一切,首帧即见呼吸 logo + 阶段小字;
// 关键样式内联在 <head>(SPLASH_STYLE,见 pwa-head),不等 app 样式表就能画。就绪后 logo 放大扩散
// + 整层淡出、露出下面已渲好的页(登录/锁屏/主页)。放行时机 = 路由 settle + 最短可见 floor +
// 硬超时兜底,判定全在 splashPhase 纯函数里(splash-lifecycle)。
//
// 组件常驻(住 RootDocument),条件渲染覆盖层:初始冷启动放行后隐藏;但**换版时(updating)会重新
// 亮起**成「更新中」—— 运行中点「更新」也要能把它叫回来(FOL-64 静默换版 + 后续切片的点更新)。

function messageKey(phase: SplashPhase): "preparing" | "loading" | "updating" {
  // exit 不是一个「文案」阶段:退场时整层在淡出,沿用上一条文案即可(见组件里的 lastMsg)。
  return phase === "updating" ? "updating" : phase === "preparing" ? "preparing" : "loading";
}

export function SplashScreen() {
  const t = useTranslations("Splash");
  const routerIdle = useRouterState({ select: (s) => s.status === "idle" });
  const updating = useSplashUpdating();

  const [hydrated, setHydrated] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const [maxElapsed, setMaxElapsed] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [released, setReleased] = useState(false);

  // 挂载后:标记 hydrated,并起最短可见 / 硬超时两个计时器。
  useEffect(() => {
    setHydrated(true);
    const min = setTimeout(() => setMinElapsed(true), SPLASH_MIN_MS);
    const max = setTimeout(() => setMaxElapsed(true), SPLASH_MAX_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(max);
    };
  }, []);

  const phase = splashPhase({ hydrated, routerIdle, minElapsed, maxElapsed, updating });

  // 放行:初始冷启动 phase 说 exit → 播放大扩散 + 淡出,动画结束后标记 released(隐藏,不销毁)。
  // updating 时 phase 恒为「更新中」,不会走到这里,所以换版态不会被退场动画抢走。
  //
  // **依赖只放 `phase`,退场用 ref 守一次**:早先依赖里带了 `exiting`,`setExiting(true)` 一改它,
  // effect 依赖变化 → 上一轮 cleanup 把「520ms 后 released」的定时器提前清掉,重跑又因 exiting 为真
  // early-return、不再重设 → released 永不为 true → 覆盖层淡到透明却留在 DOM 最上层、吃掉所有点击
  // (登录页点不动输入框/按钮就是这个)。
  const exitStarted = useRef(false);
  useEffect(() => {
    if (phase !== "exit" || exitStarted.current) return;
    exitStarted.current = true;
    setExiting(true);
    const timer = setTimeout(() => setReleased(true), SPLASH_EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // 退场时冻结文案(exit 不是文案阶段):记住最后一条非退场文案。
  const lastMsg = useRef<"preparing" | "loading" | "updating">("preparing");
  if (phase !== "exit") lastMsg.current = messageKey(phase);
  const msg = lastMsg.current;

  // 可见 = 初始还没放行,或正在换版(换版把已隐藏的覆盖层重新叫回)。
  if (released && !updating) return null;

  return (
    // data-exit 只在初始退场时给;换版态(updating)不放大扩散,只呼吸 + 「更新中」直到 reload。
    <div id="app-splash" data-exit={exiting && !updating ? "true" : undefined} aria-hidden="true">
      <Logo id="folio-splash-logo" />
      {/* 无入场/切换动画(避免冷启动那下的屏闪):原地换字,不用 key 重挂。 */}
      <p id="folio-splash-msg">{t(msg)}</p>
    </div>
  );
}
