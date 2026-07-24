import type { ConnectorId } from "@folio/connectors";
import { cn } from "@folio/ui";
import { useConnectorLabels } from "../hooks/use-connector-labels";

// connector 徽章:统一的 muted 小标(仅 shadcn 设计 token,不用任意色值)。列表行与详情头共用。
// 展示名经 useConnectorLabels(server registry 目录,React Query 去重+缓存)。
// className:调用方按上下文微调 —— 如列表行传 group-hover:bg-background,让徽章在 hover pill(bg-muted)上不与之融为一体。
export function ConnectorBadge({
  connectorId,
  className,
}: {
  connectorId: ConnectorId;
  className?: string;
}) {
  const labelOf = useConnectorLabels();
  return (
    <span
      className={cn(
        "rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {labelOf(connectorId)}
    </span>
  );
}
