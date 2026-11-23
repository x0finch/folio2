import { cn, Dock, DockItem, SharedLayoutBg, Skeleton } from "@folio/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, Settings, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import type { SyncStatusSummary } from "@/lib/core/sync-status";
import { DEFAULT_PAGE, isPageSlug, type PageKey } from "@/routes/_authed/-page-keys";
import { OverviewSkeleton } from "@/routes/_authed/-page-skeletons";
import { Logo } from "./logo";
import { PageHeader } from "./page-header";

// iOS Safari only applies `:active` when a touch listener is attached; module-level for a stable identity.
const NOOP = () => {};

const NAVS = [
  { key: "overview", page: undefined, icon: Home },
  { key: "accounts", page: "accounts", icon: Wallet },
  { key: "insights", page: "insights", icon: BarChart3 },
  { key: "settings", page: "settings", icon: Settings },
] as const;

// Layout boxes shared with AppShellSkeleton so the page doesn't jump when data arrives.
const SHELL_ROOT = "min-h-svh lg:flex";
const SHELL_ASIDE =
  "hidden w-59 shrink-0 flex-col border-border border-r bg-card px-3.5 py-4.5 lg:sticky lg:top-0 lg:flex lg:h-svh lg:overflow-y-auto";
const SHELL_BRAND_ROW = "flex items-center gap-2.5 px-2 pt-1.5 pb-5";
const SHELL_INNER_COL = "flex min-w-0 flex-1 flex-col";
const SHELL_SIDEBAR_FOOTER = "mt-auto flex items-center gap-2.5 px-1 pt-4";
const SHELL_TOPBAR =
  "sticky top-0 z-30 flex items-center gap-2.5 border-border border-b bg-background/80 px-4 pt-[calc(0.75rem_+_env(safe-area-inset-top))] pb-3 backdrop-blur-xl lg:hidden";
// Mobile content is always taller than the screen: iOS sizes the bottom inset by scrollability,
// so a short loading state then a long page would make the Dock jump ~60px.
const SHELL_MAIN =
  "relative mx-auto min-h-[calc(100svh_+_4rem)] w-full max-w-5xl flex-1 px-4 pt-6 pb-28 lg:min-h-0 lg:px-8 lg:pb-10";
const SHELL_DOCK_WRAP =
  "-translate-x-1/2 fixed bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] left-1/2 z-40 lg:hidden";

// Span version of the ui Skeleton: a <div> inside h1/p makes the browser restructure the
// server HTML and hydration fails.
function SkeletonText({ className }: { className?: string }) {
  return (
    <span
      data-slot="skeleton"
      className={cn("inline-block animate-pulse rounded-md bg-muted align-middle", className)}
    />
  );
}

function Brand() {
  return (
    <>
      <Logo className="size-6 shrink-0" />
      <span className="font-semibold text-lg tracking-tight">folio</span>
    </>
  );
}

export function AppShell({
  userName,
  syncStatus,
  selector,
  onNavIntent,
  children,
}: {
  userName: string;
  syncStatus: SyncStatusSummary;
  // Renders nothing with fewer than two portfolios.
  selector?: ReactNode;
  // The shell only reports nav intent; the route layer does the prefetching, keeping
  // server-side queries out of this module so AppShellSkeleton stays dependency-free.
  onNavIntent?: (key: PageKey) => void;
  children: ReactNode;
}) {
  const t = useTranslations("Nav");
  const th = useTranslations("PageHeader");
  const ts = useTranslations("Sidebar");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const seg = pathname.split("/")[1] ?? "";
  const activeKey: PageKey = isPageSlug(seg) ? seg : DEFAULT_PAGE;
  const activeNav = NAVS.find((n) => n.key === activeKey) ?? NAVS[0];
  const pageTitle = t(activeNav.key);
  const pageSub =
    activeNav.key === DEFAULT_PAGE
      ? th("overviewSub", { count: syncStatus.total })
      : th(`${activeNav.key}Sub` as "accountsSub" | "insightsSub" | "settingsSub");
  const initial = userName.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className={SHELL_ROOT}>
      <aside className={SHELL_ASIDE}>
        <div className={SHELL_BRAND_ROW}>
          <Brand />
        </div>

        <nav className="mt-4">
          <SharedLayoutBg className="gap-1" inset={0} pillClassName="rounded-lg bg-muted">
            {NAVS.map(({ key, page, icon: Icon }) => (
              <Link
                key={key}
                to="/{-$page}"
                params={{ page }}
                onPointerDown={() => onNavIntent?.(key)}
                aria-current={key === activeKey ? "page" : undefined}
                className={cn(
                  "block rounded-lg px-3 py-2 font-medium text-sm transition-colors",
                  key === activeKey
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {/* Flex must be on this inner span: SharedLayoutBg wraps children in a non-flex div. */}
                <span className="flex items-center gap-3 [&_svg]:size-4">
                  <Icon />
                  {t(key)}
                </span>
              </Link>
            ))}
          </SharedLayoutBg>
        </nav>

        <div className={SHELL_SIDEBAR_FOOTER}>
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-foreground text-xs">
            {initial}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate font-medium text-xs">{userName}</div>
            <div className="text-muted-foreground text-xs">{ts("selfHosted")}</div>
          </div>
        </div>
      </aside>

      <div className={SHELL_INNER_COL}>
        {/* Top padding adds safe-area-inset-top so content clears the notch under viewport-fit=cover. */}
        <header className={SHELL_TOPBAR}>
          <Brand />
        </header>

        <main className={SHELL_MAIN}>
          <PageHeader
            title={pageTitle}
            subtitle={pageSub}
            eyebrow={activeNav.key !== "settings" ? selector : null}
          />
          {children}
        </main>
      </div>

      <nav className={SHELL_DOCK_WRAP}>
        <Dock>
          {NAVS.map(({ key, page, icon: Icon }) => (
            <DockItem key={key} active={key === activeKey}>
              <Link
                to="/{-$page}"
                params={{ page }}
                aria-label={t(key)}
                // Required for `:active` on iOS Safari; removing it kills press feedback there.
                onTouchStart={NOOP}
                onPointerDown={() => onNavIntent?.(key)}
                className="group flex size-full items-center justify-center"
              >
                {/* Press feedback via CSS `:active`: motion's `whileTap` had no measurable effect
                    here. Scale the span, not the 44px Link hit area. motion-reduce keeps the
                    state change, only drops the transition. */}
                <span className="flex transition-[transform,opacity] duration-100 ease-out group-active:scale-[0.82] group-active:opacity-60 motion-reduce:transition-none">
                  <Icon className="size-5" />
                </span>
              </Link>
            </DockItem>
          ))}
        </Dock>
      </nav>
    </div>
  );
}

// The only thing the server renders. Zero props, hooks and queries: the free tier allows 10ms
// of CPU per request, and the HTML is cacheable, so it must never contain user identity.
// Shares the SHELL_* boxes with AppShell so the swap doesn't shift layout.
export function AppShellSkeleton({ note }: { note?: ReactNode }) {
  return (
    <div className={SHELL_ROOT}>
      <aside className={SHELL_ASIDE}>
        <div className={SHELL_BRAND_ROW}>
          <Brand />
        </div>

        {/* Bar is h-5 = the 20px text-sm line box in the real nav rows, so each row
            lands at the same 36px total height (py-2 + 20px). */}
        <nav className="mt-4 flex flex-col gap-1">
          {NAVS.map(({ key, icon: Icon }) => (
            <div key={key} className="flex items-center gap-3 rounded-lg px-3 py-2">
              <Icon className="size-4 shrink-0 text-muted-foreground/40" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </nav>

        <div className={SHELL_SIDEBAR_FOOTER}>
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      </aside>

      <div className={SHELL_INNER_COL}>
        <header className={SHELL_TOPBAR}>
          <Brand />
        </header>

        <main className={SHELL_MAIN}>
          {/* Every box below is measured against the real Overview at 390px (the landing
              page): eyebrow row 25, title 38, subtitle 20, content starts at 198, hero
              240, tab row 32, list rows 72 each. Keep them in step — a box that drifts
              here is a jump the moment the browser takes over. */}
          <Skeleton className="absolute top-6 right-4 h-9 w-40 rounded-full lg:right-8" />
          {/* Render the REAL <PageHeader> (hook-free, provider-free — the shell's
              zero-provider constraint holds) with skeleton bars in its slots: the real
              h1/p supply the line boxes, so nothing is hand-transcribed to drift.
              inline-block matters: a block bar would collapse the h1's text line box. */}
          <PageHeader
            eyebrow={<SkeletonText className="h-6 w-20 rounded-full" />}
            title={<SkeletonText className="h-8 w-44" />}
            subtitle={<SkeletonText className="h-4 w-60" />}
          />
          {/* The same skeleton the Overview page uses, so the swap is pixel-stable. */}
          <OverviewSkeleton />
        </main>
      </div>

      {/* Text comes from the caller: the skeleton must render without an i18n provider. */}
      {note ? (
        <p className="-translate-x-1/2 pointer-events-none fixed bottom-28 left-1/2 z-30 whitespace-nowrap text-muted-foreground text-sm lg:bottom-8">
          {note}
        </p>
      ) : null}

      <nav className={SHELL_DOCK_WRAP}>
        <Dock>
          {NAVS.map(({ key, icon: Icon }) => (
            <DockItem key={key}>
              <span className="flex size-full items-center justify-center">
                <Icon className="size-5 text-muted-foreground/40" />
              </span>
            </DockItem>
          ))}
        </Dock>
      </nav>
    </div>
  );
}
