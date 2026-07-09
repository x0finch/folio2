import type { ConnectorId } from "@folio/connectors";
import { connectorLabel } from "../lib/connectors";

// connector 徽章:统一的 muted 小标(仅 shadcn 设计 token,不用任意色值)。列表行与详情头共用。
export function ConnectorBadge({ connectorId }: { connectorId: ConnectorId }) {
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      {connectorLabel(connectorId)}
    </span>
  );
}
