import { type SyncAction, SyncStatus } from "@/components/sync-status";
import { usePortfolio } from "@/lib/hooks/use-portfolio";
import { useSyncStatus } from "@/lib/queries/sync";

// Sync entry at the top right, absolutely positioned where PageHeader actions would sit (<main> is
// the positioning context). Reads the sync summary from the react-query cache; each page that
// needs it renders its own <HeaderSync/>.
export function HeaderSync({
  action,
  autoSyncWhenStale,
}: {
  action?: SyncAction;
  /** Auto-sync a round when data is stale. Only the home page passes this. */
  autoSyncWhenStale?: boolean;
}) {
  // Follows the selected portfolio.
  const { selectedId } = usePortfolio();
  const syncStatus = useSyncStatus(selectedId);
  return (
    // `data-slot`: e2e measures its position in the page header.
    <div data-slot="header-sync" className="absolute top-6 right-4 z-20 lg:right-8">
      <SyncStatus
        summary={syncStatus}
        action={action}
        autoSync={autoSyncWhenStale ? { lastSyncedAt: syncStatus.lastSyncedAt } : undefined}
      />
    </div>
  );
}
