import { useRouterState } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
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

// 冷启动闪屏(ADR 0051)。**包住 children、按需「不画」而不是「盖住」**:未放行前把页面内容设
// visibility:hidden —— 它照常 SSR/hydrate/预热骨架,只是不绘制,于是没有任何东西能抢在覆盖层之前
// 露脸(遮罩式覆盖层挡不住的那些缝:SSR 流式绘制时序、iOS 合成透明、z-index 竞争,这里从根上不存在)。
// 覆盖层(呼吸 logo + 阶段小字)画在最上层;就绪后 logo 放大扩散 + 整层淡出,同时露出下面已渲好的页。
// 关键样式内联在 <head>(SPLASH_STYLE,见 pwa-head),不等 app 样式表就能画。放行时机 = 路由 settle +
// 最短可见 floor + 硬超时兜底,判定全在 splashPhase 纯函数里(splash-lifecycle)。
//
// 组件常驻(住 RootDocument):初始冷启动放行后覆盖层卸载、页面常驻;换版时(updating)覆盖层重新
// 亮起成「更新中」、页面重新藏起,直到 reload。

// 未放行时给页面容器的样式:留在 DOM(布局/hydration 照常),仅不绘制。
const CONTENT_HIDDEN: CSSProperties = { visibility: "hidden" };

function messageKey(phase: SplashPhase): "preparing" | "loading" | "updating" {
  // exit 不是一个「文案」阶段:退场时整层在淡出,沿用上一条文案即可(见组件里的 lastMsg)。
  return phase === "updating" ? "updating" : phase === "preparing" ? "preparing" : "loading";
}

export function SplashScreen({ children }: { children: ReactNode }) {
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

  // 放行:初始冷启动 phase 说 exit → 播放大扩散 + 淡出,动画结束后标记 released(隐藏覆盖层)。
  // updating 时 phase 恒为「更新中」,不会走到这里,所以换版态不会被退场动画抢走。
  //
  // **依赖只放 `phase`,退场用 ref 守一次**:早先依赖里带了 `exiting`,`setExiting(true)` 一改它,
  // effect 依赖变化 → 上一轮 cleanup 把「520ms 后 released」的定时器提前清掉,重跑又因 exiting 为真
  // early-return、不再重设 → released 永不为 true → 覆盖层留着挡点击(登录页点不动就是这个)。
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

  // 页面露出时机:退场淡出一开始就露(与覆盖层淡出做交叉溶解),放行后常驻;换版态一直藏着直到 reload。
  const revealContent = (exiting || released) && !updating;
  // 覆盖层是否还在:初始未放行,或换版把已隐藏的覆盖层重新叫回。
  const overlayMounted = !(released && !updating);

  return (
    <>
      <div id="app-content" style={revealContent ? undefined : CONTENT_HIDDEN}>
        {children}
      </div>
      {overlayMounted && (
        // data-exit 只在初始退场时给;换版态(updating)不放大扩散,只呼吸 + 「更新中」直到 reload。
        <div
          id="app-splash"
          data-exit={exiting && !updating ? "true" : undefined}
          aria-hidden="true"
        >
          <Logo id="folio-splash-logo" />
          {/* 无入场/切换动画(避免冷启动那下的屏闪):原地换字,不用 key 重挂。 */}
          <p id="folio-splash-msg">{t(msg)}</p>
        </div>
      )}
    </>
  );
}
