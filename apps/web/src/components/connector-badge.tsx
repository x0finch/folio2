import type { ConnectorId } from "@folio/connectors";
import { cn } from "@folio/ui";
import { useQuery } from "@tanstack/react-query";
import { connectorLabelFallback } from "@/lib/core/logo";
import { connectorCatalogQuery } from "@/lib/queries/connectors";

export function ConnectorBadge({
  connectorId,
  className,
}: {
  connectorId: ConnectorId;
  className?: string;
}) {
  const { data: catalog } = useQuery(connectorCatalogQuery());
  return (
    <span className={cn("text-sm text-muted-foreground", className)}>
      {catalog?.[connectorId]?.label ?? connectorLabelFallback(connectorId)}
    </span>
  );
}
