import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  isRedirect,
  Outlet,
  redirect,
  retainSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { z } from "zod";
import { AppShell, AppShellSkeleton } from "@/components/app-shell";
import { LockScreen } from "@/components/lock-screen";
import { PortfolioSelector } from "@/components/portfolio-selector";
import { BalancePrivacyProvider } from "@/lib/hooks/use-balance-privacy";
import { readLockFlag } from "@/lib/hooks/use-idle-lock";
import { PortfolioProvider, pickSelectedPortfolio, usePortfolio } from "@/lib/hooks/use-portfolio";
import {
  CurrencyProvider,
  readStoredCurrency,
  useStoredCurrency,
} from "@/lib/hooks/use-prefer-currency";
import { RETRY, withRetry } from "@/lib/queries/constants";
import { watchDataVersion } from "@/lib/queries/data-version";
import { dataVersionKeys } from "@/lib/queries/keys";
import { forgetQueryCache, queryPersistence } from "@/lib/queries/persist";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { currencyPreferenceQuery } from "@/lib/queries/preferences";
import { dataVersionQuery, valuationSettingsQuery } from "@/lib/queries/settings";
import { prefetchSyncStatusAtoms } from "@/lib/queries/sync";
import { getSession } from "@/lib/server/session";
import type { PageKey } from "./_authed/-page-keys";
import { prefetchPage } from "./_authed/-pages";

// Redirect to /login is UX only; data security is enforced by each authed server fn.
export const Route = createFileRoute("/_authed")({
  // No SSR for the signed-in tree: the free plan gives 10ms CPU per request, while server-rendering
  // these pages runs ~26 queries (~3s). Must be `false`, not 'data-only' (which still runs loaders
  // on the server). Inherited by the whole subtree, beforeLoad included.
  ssr: false,
  // Same component as the static shell's ClientOnly fallback, so the first frame doesn't flicker.
  pendingComponent: PendingShell,
  // `.catch(undefined)`: a malformed param must not break the page; unknown ids fall back to default.
  validateSearch: z.object({
    portfolio: z.string().min(1).optional().catch(undefined),
  }),
  // Respects an explicit `portfolio: undefined`, so switching back to default drops the param.
  search: { middlewares: [retainSearchParams(["portfolio"])] },
  beforeLoad: async ({ abortController, context }) => {
    // Not a cached query, so the QueryClient retry defaults don't apply. The signal must be wired:
    // otherwise every cancelled navigation leaves a retry loop hitting the server.
    const current = await withRetry(getSession, isRedirect, RETRY.forever, abortController.signal);
    if (!current) {
      await forgetQueryCache(context.queryClient);
      throw redirect({ to: "/login" });
    }
    // Restore the persisted cache before the loader so ensureQueryData can hit it. Skipped while
    // locked.
    await queryPersistence().start(context.queryClient, current.user.id, {
      locked: readLockFlag(),
    });
    // Fetch the data version before the loader's data requests: the watcher takes the first version
    // it sees as baseline, which is only correct if that version isn't newer than the data.
    if (!context.queryClient.getQueryData(dataVersionKeys.all)) {
      void context.queryClient.prefetchQuery(dataVersionQuery());
    }
    return { user: current.user };
  },
  // No `loaderDeps` on purpose: it would make each portfolio switch a new match, re-running
  // beforeLoad (another getSession round trip). The header summary refetches on its own.
  loader: async ({ context, location, cause }) => {
    // Fire-and-forget: the privacy provider fails closed until this resolves.
    context.queryClient.ensureQueryData(valuationSettingsQuery());
    // The sync summary needs the portfolio list to resolve the selected id.
    const [, portfolios] = await Promise.all([
      context.queryClient.ensureQueryData(currencyPreferenceQuery(readStoredCurrency())),
      context.queryClient.ensureQueryData(portfolioListQuery()),
    ]);
    // `location.search` is the raw, unvalidated parse here, hence `unknown`.
    const requested = (location.search as { portfolio?: unknown }).portfolio;
    const selectedId = pickSelectedPortfolio(
      requested,
      portfolios.portfolios,
      portfolios.defaultId,
    );
    const summaryAtoms = prefetchSyncStatusAtoms(context.queryClient, selectedId);
    // Await only on first entry: the header summary has no suspense boundary of its own. On "stay"
    // re-runs, suspending the shell would hide it and break the header pill animation; `{-$page}`'s
    // loader awaits instead.
    if (cause === "enter") await summaryAtoms;
  },
  component: AuthedLayout,
  // Final net after retries are exhausted; keeps re-running the route so it self-heals.
  errorComponent: StalledShell,
});

/** Shorter waits are a normal first paint and need no explanation. */
const SAY_STALLED_AFTER = 12_000;

// The first frame has no note, so it matches the build-time static shell pixel for pixel.
function PendingShell() {
  const t = useTranslations("Shell");
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), SAY_STALLED_AFTER);
    return () => clearTimeout(timer);
  }, []);
  return <AppShellSkeleton note={stalled ? t("stalled") : null} />;
}

// Catches render errors only: a failed fetch leaves the match in error state that `reset` can't
// clear, so fetches are guarded by retrying forever instead.
function StalledShell({ reset }: { reset?: () => void }) {
  const t = useTranslations("Shell");
  useEffect(() => {
    if (!reset) return;
    const timer = setInterval(reset, RETRY.selfHeal);
    return () => clearInterval(timer);
  }, [reset]);
  return <AppShellSkeleton note={t("stalled")} />;
}

// Inside PortfolioProvider: prefetching depends on the selected portfolio.
function ShellWithSync({ userName, children }: { userName: string; children: ReactNode }) {
  const { selectedId } = usePortfolio();
  const queryClient = useQueryClient();
  // Warm a page's chunk + data on nav-item press; with strict lazy loading this is the only head
  // start. Lives here because the shell file must keep AppShellSkeleton dependency-free.
  const warm = (page: PageKey) => prefetchPage(page, queryClient, selectedId);
  // Inside the lock screen on purpose: nothing to refresh while locked.
  useEffect(() => watchDataVersion(queryClient, dataVersionQuery()), [queryClient]);
  return (
    <AppShell userName={userName} selector={<PortfolioSelector />} onNavIntent={warm}>
      {children}
    </AppShell>
  );
}

function AuthedLayout() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  // Signed out in another tab: the cookie is shared, so go to /login. Outside the lock screen so
  // locked tabs leave too.
  useEffect(
    () => queryPersistence().onSignedOutElsewhere(() => void navigate({ to: "/login" })),
    [navigate],
  );
  const currencyCode = useStoredCurrency();
  const { data: preferCurrency } = useSuspenseQuery(currencyPreferenceQuery(currencyCode));
  const { data: portfolios } = useSuspenseQuery(portfolioListQuery());
  // Not suspense: the loader only prefetches it and the provider fails closed while undefined.
  const { data: settings } = useQuery(valuationSettingsQuery());
  return (
    <CurrencyProvider value={preferCurrency}>
      {/* The URL `?portfolio=` is the source of truth for the selection. */}
      <PortfolioProvider portfolios={portfolios.portfolios} defaultId={portfolios.defaultId}>
        <BalancePrivacyProvider hideBalances={settings?.hideBalances}>
          {/* Unmounts the app below while locked, leaving no content in the DOM. */}
          <LockScreen>
            <ShellWithSync userName={user.name || user.email || ""}>
              <Outlet />
            </ShellWithSync>
          </LockScreen>
        </BalancePrivacyProvider>
      </PortfolioProvider>
    </CurrencyProvider>
  );
}
