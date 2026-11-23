import { Activity, type ComponentType, type ReactNode, Suspense, useEffect, useState } from "react";
import { RevealContext } from "./stagger-reveal";

// Route-agnostic page switcher: takes a page registry and the current key. Visited pages are kept
// alive in React `<Activity>` (hidden = state and DOM kept, effects cleared); unvisited pages stay
// out of the tree so their lazy chunk is never requested. The entrance animation lives in
// `StaggerReveal`; this layer only signals "replay" and does no whole-page fade (it wraps the
// absolute `<HeaderSync/>`, and it would double-fade).

export interface SwitcherPage<K extends string> {
  key: K;
  /** Usually `React.lazy(() => import(...))`. */
  Component: ComponentType;
  /** Skeleton shown while the page's chunk first loads. */
  Skeleton: ComponentType;
}

// A keep-alive panel: `<Activity>` handles visibility; this bumps a counter each time the page
// becomes current so `StaggerReveal` replays. Keyed on an active effect because hidden Activities
// clear effects and rerun them on reveal; the counter only grows and no remount happens.
// `data-page` lets tests read which pages are in the tree and which is visible.
function Panel({
  pageKey,
  active,
  children,
}: {
  pageKey: string;
  active: boolean;
  children: ReactNode;
}) {
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (!active) return;
    setReveal((n) => n + 1);
  }, [active]);
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <div data-page={pageKey}>
        <RevealContext.Provider value={reveal}>{children}</RevealContext.Provider>
      </div>
    </Activity>
  );
}

export function PageSwitcher<K extends string>({
  pages,
  activeKey,
}: {
  pages: readonly SwitcherPage<K>[];
  activeKey: K;
}) {
  // Visited pages only grow, keeping unvisited ones (and their chunks) out.
  const [visited, setVisited] = useState<Set<K>>(() => new Set([activeKey]));
  // Added during render (React's "adjust state while rendering") so the new page mounts in the same commit with no blank frame.
  if (!visited.has(activeKey)) {
    setVisited((prev) => new Set(prev).add(activeKey));
  }

  return (
    <div>
      {pages
        .filter((p) => visited.has(p.key))
        .map((p) => (
          <Panel key={p.key} pageKey={p.key} active={p.key === activeKey}>
            {/* Tests assert on the skeleton's page name. */}
            <Suspense
              fallback={
                <div data-page-skeleton={p.key}>
                  <p.Skeleton />
                </div>
              }
            >
              <p.Component />
            </Suspense>
          </Panel>
        ))}
    </div>
  );
}
