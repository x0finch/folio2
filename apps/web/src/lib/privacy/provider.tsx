import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useReducer } from "react";
import { valuationSettingsQuery } from "@/lib/queries/settings";
import { readCachedHideBalances, writeCachedHideBalances } from "./cache";
import { type BalancePrivacy, BalancePrivacyContext } from "./context";
import { isHidden, privacyReducer, REVEAL_IDLE_MS, resolveInitialEnabled } from "./state";

// 余额隐私 Provider(FOL-75,ADR 0052)。挂在认证区顶层,底下每处金额靠 `<Sensitive>` 读它。
// 纯状态机在 state.ts(已单测);这里只做三件 DOM/React 侧的接线:读服务器权威值、收「离开」信号、
// 空闲计时。**只在浏览器**(认证区 ssr:false)。Context + hook 在 ./context(与本文件拆开,理由见那)。

// 空闲计时用的活动事件:任一发生就重置「距上次活动多久」。同 idle-lock 的那组。
const ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "pointerdown",
  "touchstart",
  "scroll",
  "wheel",
] as const;

export function BalancePrivacyProvider({ children }: { children: ReactNode }) {
  // 冷启动**同步**读缓存当初值(lazy init 只跑一次):缓存 OFF 直接不遮、不闪;没缓存 fail-closed
  // 先遮,等下面 sync 校准(resolveInitialEnabled)。
  const [state, dispatch] = useReducer(privacyReducer, null, () => ({
    enabled: resolveInitialEnabled(readCachedHideBalances()),
    revealed: false,
  }));

  // 服务器权威值(与估值口径同一份读,已在 _authed loader 预取)。到位 / 变化即 sync 校准 + 写回缓存。
  const { data } = useQuery(valuationSettingsQuery());
  const serverHide = data?.hideBalances;
  useEffect(() => {
    if (serverHide === undefined) return;
    dispatch({ type: "sync", hideBalances: serverHide });
    writeCachedHideBalances(serverHide);
  }, [serverHide]);

  const reveal = useCallback(() => dispatch({ type: "reveal" }), []);
  const leave = useCallback(() => dispatch({ type: "leave" }), []);

  // 「离开」信号 → 收回临时显示:切后台(visibilitychange→hidden)、窗口失焦(blur)。
  // 这两个是 ADR 0052 的关键——回前台快照那条路不做,收回只发生在**离开**边界。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", leave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", leave);
    };
  }, [leave]);

  // 空闲计时:临时显示中、一段时间没动作 → 自动收回。只在 revealed 时挂,活动重置计时(真·空闲)。
  useEffect(() => {
    if (!state.revealed) return;
    let timer = window.setTimeout(leave, REVEAL_IDLE_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = window.setTimeout(leave, REVEAL_IDLE_MS);
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, bump, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, bump);
    };
  }, [state.revealed, leave]);

  const value = useMemo<BalancePrivacy>(
    () => ({ hidden: isHidden(state), reveal }),
    [state, reveal],
  );
  return <BalancePrivacyContext.Provider value={value}>{children}</BalancePrivacyContext.Provider>;
}
