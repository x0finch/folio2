import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { Logo } from "@/components/logo";
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
// 硬超时兜底,判定全在 splashPhase 纯函数里(splash-lifecycle)。一次性:放行后返回 null 卸载,
// SPA 导航不复现。
//
// 「更新中」阶段(updating)本片恒 false —— SW 更新流(FOL-64)再接线。

function messageKey(phase: SplashPhase): "preparing" | "loading" | "updating" {
  // exit 不是一个「文案」阶段:退场时整层在淡出,沿用上一条文案即可(见组件里的 lastMsg)。
  return phase === "updating" ? "updating" : phase === "preparing" ? "preparing" : "loading";
}

export function SplashScreen() {
  const t = useTranslations("Splash");
  const routerIdle = useRouterState({ select: (s) => s.status === "idle" });

  const [hydrated, setHydrated] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const [maxElapsed, setMaxElapsed] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [done, setDone] = useState(false);

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

  const phase = splashPhase({ hydrated, routerIdle, minElapsed, maxElapsed, updating: false });

  // 放行:phase 说 exit → 播放大扩散 + 淡出,动画结束后卸载。
  useEffect(() => {
    if (phase !== "exit" || exiting) return;
    setExiting(true);
    const t = setTimeout(() => setDone(true), SPLASH_EXIT_MS);
    return () => clearTimeout(t);
  }, [phase, exiting]);

  // 退场时冻结文案(exit 不是文案阶段):记住最后一条非退场文案。
  const lastMsg = useRef<"preparing" | "loading" | "updating">("preparing");
  if (phase !== "exit") lastMsg.current = messageKey(phase);
  const msg = lastMsg.current;

  if (done) return null;

  return (
    <div id="app-splash" data-exit={exiting ? "true" : undefined} aria-hidden="true">
      <Logo id="folio-splash-logo" />
      {/* key 变即重挂 → 重放 folio-splash-msg-in 的 crossfade(reduced-motion 下为瞬切)。 */}
      <p id="folio-splash-msg" key={msg}>
        {t(msg)}
      </p>
    </div>
  );
}
