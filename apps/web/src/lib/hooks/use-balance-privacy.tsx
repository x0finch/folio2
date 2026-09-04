import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import {
  HIDE_BALANCES_CACHE_KEY,
  isHidden,
  parseCachedHideBalances,
  privacyReducer,
  REVEAL_IDLE_MS,
  resolveInitialEnabled,
  serializeHideBalances,
} from "./balance-privacy";

// 余额隐私的客户端归属(FOL-75,ADR 0052):Provider + hook + 副作用(读服务器权威值、收「离开」信号、
// 空闲计时)。纯状态机在 ./balance-privacy(已单测);对标 idle-lock 的 idle-lock.ts + use-idle-lock。
// **权威值(hideBalances)由外层当 prop 喂进来**,而不是这里 import 那份 query —— 那条链挂着
// server-only 的 `cloudflare:workers`,一旦被 <Sensitive> 这类展示件间接 import 就进不了 node 组件测试。
// 装配点(_authed)本来就读那份 query,顺手把值传下来即可;这里只剩纯客户端逻辑。**只在浏览器**。

interface BalancePrivacy {
  /** 此刻要不要遮。 */
  hidden: boolean;
  /** 点了某个值:临时显示全部(点一处全显)。 */
  reveal: () => void;
}

// 没有 Provider 时的缺省:隐私关(永不遮)。Provider 在认证区顶层恒挂;拿不到它的场景(孤立渲染的
// 组件测试、认证区之外万一复用某个金额件)按「不遮」渲染即可,别抛异常把页面打没。
const PRIVACY_OFF: BalancePrivacy = { hidden: false, reveal: () => {} };

const BalancePrivacyContext = createContext<BalancePrivacy | null>(null);

export function useBalancePrivacy(): BalancePrivacy {
  return useContext(BalancePrivacyContext) ?? PRIVACY_OFF;
}

// hide_balances 的 localStorage **双向**缓存(ADR 0052):冷启动同步读它当初值,消掉「等服务器读回来
// 之前那一下模糊闪现」;每次权威值变化都写回。读写吞异常(隐私窗口 / 禁用存储)→ 退回「没缓存」→
// fail-closed(resolveInitialEnabled)。同 idle-lock 的 localStorage 包装,不单测,纯逻辑在 parse/serialize。
function readCachedHideBalances(): boolean | null {
  try {
    return parseCachedHideBalances(localStorage.getItem(HIDE_BALANCES_CACHE_KEY));
  } catch {
    return null;
  }
}
function writeCachedHideBalances(value: boolean): void {
  try {
    localStorage.setItem(HIDE_BALANCES_CACHE_KEY, serializeHideBalances(value));
  } catch {}
}

// 空闲计时用的活动事件:任一发生就重置「距上次活动多久」。同 idle-lock 的那组。
const ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "pointerdown",
  "touchstart",
  "scroll",
  "wheel",
] as const;

export function BalancePrivacyProvider({
  hideBalances,
  children,
}: {
  /** 服务器权威值(来自 user_settings,由装配点读 query 传入);`undefined` = 还没读到。 */
  hideBalances: boolean | undefined;
  children: ReactNode;
}) {
  // 冷启动**同步**读缓存当初值(lazy init 只跑一次):缓存 OFF 直接不遮、不闪;没缓存 fail-closed
  // 先遮,等下面 sync 校准(resolveInitialEnabled)。
  const [state, dispatch] = useReducer(privacyReducer, null, () => ({
    enabled: resolveInitialEnabled(readCachedHideBalances()),
    revealed: false,
  }));

  // 权威值到位 / 变化即 sync 校准 + 写回缓存(双向缓存)。
  useEffect(() => {
    if (hideBalances === undefined) return;
    dispatch({ type: "sync", hideBalances });
    writeCachedHideBalances(hideBalances);
  }, [hideBalances]);

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
