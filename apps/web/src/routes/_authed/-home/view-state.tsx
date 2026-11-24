import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { DEFAULT_TAB } from "./home-tabs";

// Page-local state for the home tab ("tokens" / "perps" / "defi" or a pin id) and the token drawer.
// Not in the URL, so neither is deep-linkable; `<Activity>` keeps it across page switches.
// - `tab`: unrecognized values (e.g. a deleted pin) fall back in the consumer's `pickShownTab`.
// - `token`: the open token's group key (`Holding.key`); `undefined` = closed.

interface HomeViewState {
  tab: string;
  setTab: (v: string) => void;
  token: string | undefined;
  setToken: (v: string | undefined) => void;
}

const HomeViewStateContext = createContext<HomeViewState | null>(null);

export function HomeViewStateProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<string>(DEFAULT_TAB);
  const [token, setToken] = useState<string | undefined>(undefined);
  const value = useMemo(() => ({ tab, setTab, token, setToken }), [tab, token]);
  return <HomeViewStateContext.Provider value={value}>{children}</HomeViewStateContext.Provider>;
}

export function useHomeViewState(): HomeViewState {
  const ctx = useContext(HomeViewStateContext);
  if (!ctx) throw new Error("useHomeViewState must be used within HomeViewStateProvider");
  return ctx;
}
