import type { ConnectorId } from "@folio/connectors";
import { typeLabel } from "../lib/account-types";

// 账户类型徽章:统一的 muted 小标(仅 shadcn 设计 token,不用任意色值)。列表行与详情头共用。
export function AccountTypeBadge({ connectorId }: { connectorId: ConnectorId }) {
  return (
    <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      {typeLabel(connectorId)}
    </span>
  );
}
