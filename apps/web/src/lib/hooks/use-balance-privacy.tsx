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

// `hideBalances` comes in as a prop rather than importing the query here: that query pulls in
// server-only `cloudflare:workers`, which would break node component tests of <Sensitive>.

interface BalancePrivacy {
  hidden: boolean;
  /** Reveals every value, not just the one clicked. */
  reveal: () => void;
}

// Without a provider (isolated component tests) render unhidden rather than throw.
const PRIVACY_OFF: BalancePrivacy = { hidden: false, reveal: () => {} };

const BalancePrivacyContext = createContext<BalancePrivacy | null>(null);

export function useBalancePrivacy(): BalancePrivacy {
  return useContext(BalancePrivacyContext) ?? PRIVACY_OFF;
}

// Cached so a cold start doesn't flash before the server value arrives; storage errors fall
// back to "no cache", which is fail-closed.
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
  /** `undefined` = not loaded yet. */
  hideBalances: boolean | undefined;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(privacyReducer, null, () => ({
    enabled: resolveInitialEnabled(readCachedHideBalances()),
    revealed: false,
  }));

  useEffect(() => {
    if (hideBalances === undefined) return;
    dispatch({ type: "sync", hideBalances });
    writeCachedHideBalances(hideBalances);
  }, [hideBalances]);

  const reveal = useCallback(() => dispatch({ type: "reveal" }), []);
  const leave = useCallback(() => dispatch({ type: "leave" }), []);

  // Reveal is withdrawn only at leave boundaries (background, blur), not on return.
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
