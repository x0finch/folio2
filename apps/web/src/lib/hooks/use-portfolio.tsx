import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";

// The URL (`?portfolio=<id>`, omitted for the default) is the single source of truth, so reload,
// shared links and the back button all agree. The pure helpers below are also used by the
// `_authed` loader.
const authed = getRouteApi("/_authed");

export interface PortfolioSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

// `requested` is `unknown` because the loader passes raw `location.search` (empty string, array,
// number). Anything not in the list falls back to the default without an error, so a deleted,
// garbage or foreign id all get the same response.
export function pickSelectedPortfolio(
  requested: unknown,
  portfolios: readonly { id: string }[],
  defaultId: string,
): string {
  if (typeof requested !== "string") return defaultId;
  return portfolios.some((p) => p.id === requested) ? requested : defaultId;
}

// Returns a whole new search: other params point at things in the old portfolio.
// The default is written as `undefined` (key present) because `retainSearchParams` would
// otherwise restore the old value; `stripSearchParams` only supports static defaults.
export function portfolioSwitchSearch(
  id: string,
  defaultId: string,
): { portfolio: string | undefined } {
  return { portfolio: id === defaultId ? undefined : id };
}

interface PortfolioContextValue {
  portfolios: PortfolioSummary[];
  defaultId: string;
  selectedId: string;
  select: (id: string) => void;
}

const PortfolioContext = createContext<PortfolioContextValue | null>(null);

export function PortfolioProvider({
  portfolios,
  defaultId,
  children,
}: {
  portfolios: PortfolioSummary[];
  defaultId: string;
  children: ReactNode;
}) {
  const { portfolio } = authed.useSearch();
  const navigate = useNavigate();
  const selectedId = pickSelectedPortfolio(portfolio, portfolios, defaultId);
  const select = (id: string) => {
    const next = portfolioSwitchSearch(id, defaultId);
    // Compare with the raw URL value, not selectedId: otherwise an unrecognised id in the URL
    // could never be cleared by picking the default.
    if (next.portfolio === portfolio) return;
    // `to: "."` stays on the current page; without it `search` is typed `never`, and `_authed`
    // is pathless so `from` can't be used.
    navigate({ to: ".", search: () => next });
  };
  return (
    <PortfolioContext.Provider value={{ portfolios, defaultId, selectedId, select }}>
      {children}
    </PortfolioContext.Provider>
  );
}

export function usePortfolio(): PortfolioContextValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error("usePortfolio must be used within PortfolioProvider");
  return ctx;
}
