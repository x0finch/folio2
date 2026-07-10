import type { ConnectorId } from "@folio/connectors";
import { useConnectorLabels } from "../lib/use-connector-labels";

// connector 徽章:统一的 muted 小标(仅 shadcn 设计 token,不用任意色值)。列表行与详情头共用。
// 展示名经 useConnectorLabels(server registry 目录,React Query 去重+缓存)。
export function ConnectorBadge({ connectorId }: { connectorId: ConnectorId }) {
  const labelOf = useConnectorLabels();
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      {labelOf(connectorId)}
    </span>
  );
}
