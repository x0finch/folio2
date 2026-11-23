import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { PageSwitcher } from "@/components/page-switcher";
import { pickSelectedPortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { prefetchSyncStatusAtoms } from "@/lib/queries/sync";
import { DEFAULT_PAGE, isPageSlug, type PageSlug } from "./-page-keys";
import { PAGES, prefetchPage } from "./-pages";

// All four pages share one route (optional `page` param), so switching pages keeps visited pages
// alive via <Activity> instead of unmounting them.
export const Route = createFileRoute("/_authed/{-$page}")({
  // An optional param matches anything; without notFound, `/anything` would render an empty shell.
  params: {
    parse: ({ page }): { page?: PageSlug } => {
      if (page !== undefined && !isPageSlug(page)) throw notFound();
      return { page };
    },
  },
  // Lives on the merged route so the kept-alive accounts page can read it even when not visible.
  validateSearch: z.object({
    focus: z.string().min(1).optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => ({ portfolio: search.portfolio }),
  // Only awaits the selected portfolio (prefetch keys must match) and the shell's two atoms; page
  // data is fired and left to each page's Suspense, so page switches are instant.
  loader: async ({ context: { queryClient }, deps, params }) => {
    const { portfolios, defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    const selectedId = pickSelectedPortfolio(deps.portfolio, portfolios, defaultId);
    prefetchPage(params.page ?? DEFAULT_PAGE, queryClient, selectedId);
    // The header pill has no Suspense boundary: on an unseen portfolio the shell would suspend,
    // get hidden, and its text-swap animation would jam with both names overlapping. Awaiting keeps
    // the old UI until these are ready; on page switches they're already cached.
    await prefetchSyncStatusAtoms(queryClient, selectedId);
  },
  component: PageHost,
});

function PageHost() {
  const { page } = Route.useParams();
  return <PageSwitcher pages={PAGES} activeKey={page ?? DEFAULT_PAGE} />;
}
