import type { ConnectorId } from "@folio/connectors";
import { LogoAvatar } from "@folio/ui";
import { CONNECTOR_OPTIONS } from "../lib/connectors";
import { useConnectorLabels, useConnectorLogos } from "../lib/use-connector-labels";

// 「添加账户」第一步:连接器网格(纯展示)。分组来自 CONNECTOR_OPTIONS,展示名 + logo 来自 registry 目录
// (useConnectorLabels/useConnectorLogos)—— 图标即各 connector manifest 自带的 logo(经 folio logo 代理),
// 加载失败/无图由 LogoAvatar 回退首字母。恒显全部 Connector(创建无唯一性约束 → 同一 connector 可多开)。
// 纯 onSelect 回调,不含表单/创建逻辑。
export function ConnectorGrid({ onSelect }: { onSelect: (connectorId: ConnectorId) => void }) {
  const labelOf = useConnectorLabels();
  const logoOf = useConnectorLogos();
  return (
    <div className="flex flex-col gap-4">
      {CONNECTOR_OPTIONS.map((group) => (
        <div key={group.group} className="flex flex-col gap-2">
          <div className="text-muted-foreground text-xs">{group.group}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {group.options.map((id) => {
              const label = labelOf(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <LogoAvatar src={logoOf(id)} fallback={label} size="sm" alt="" />
                  <span className="font-medium text-sm">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
