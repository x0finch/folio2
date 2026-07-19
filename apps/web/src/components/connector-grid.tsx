import type { ConnectorId } from "@folio/connectors";
import { cn } from "@folio/ui";
import { CONNECTOR_ICON } from "../lib/connector-icons";
import { CONNECTOR_OPTIONS } from "../lib/connectors";
import { useConnectorLabels } from "../lib/use-connector-labels";

// 「添加账户」第一步:连接器网格(纯展示)。分组来自 CONNECTOR_OPTIONS,展示名来自 registry 目录(useConnectorLabels),
// 图标来自 CONNECTOR_ICON。恒显全部 Connector(创建无唯一性约束 → 同一 connector 可多开,不隐藏已添加)。
// 纯 onSelect 回调,不含表单/创建逻辑。所有配色只走 design token(图标随 currentColor)。
export function ConnectorGrid({ onSelect }: { onSelect: (connectorId: ConnectorId) => void }) {
  const labelOf = useConnectorLabels();
  return (
    <div className="flex flex-col gap-4">
      {CONNECTOR_OPTIONS.map((group) => (
        <div key={group.group} className="flex flex-col gap-2">
          <div className="text-muted-foreground text-xs">{group.group}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {group.options.map((id) => {
              const Icon = CONNECTOR_ICON[id];
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  className={cn(
                    "flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-3 text-left",
                    "transition-colors hover:border-foreground/20 hover:bg-muted",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  )}
                >
                  <Icon className="size-5 text-muted-foreground" aria-hidden />
                  <span className="font-medium text-sm">{labelOf(id)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
