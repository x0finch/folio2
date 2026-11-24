import type { ConnectorId } from "@folio/connectors";
import { cn } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { connectorLabelFallback } from "@/lib/core/logo";
import { connectorCatalogQuery } from "@/lib/queries/connectors";

// className lets callers tweak per context, e.g. `group-hover:bg-background` so the badge
// doesn't blend into a hover pill.
export function ConnectorBadge({
  connectorId,
  className,
}: {
  connectorId: ConnectorId;
  className?: string;
}) {
  const { data: catalog } = useQuery(connectorCatalogQuery());
  return (
    <span
      className={cn(
        "rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {catalog?.[connectorId]?.label ?? connectorLabelFallback(connectorId)}
    </span>
  );
}
