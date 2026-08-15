import { useQuery } from "@tanstack/react-query";
import { connectorLabelFallback } from "../../../../lib/connector-label";
import { connectorCatalogQuery } from "../../../../lib/queries/connectors";
import type { PinTargetChoice } from "./pin-picker";
import { PinTargetMark } from "./pin-target-mark";

// 选择器用:仍走连接器目录(打开选择器才拉)。tab 条不要用它 —— 一挂就打目录。
export function PinTargetLabel({
  target,
  name,
  onPrimary,
  className,
}: {
  target: PinTargetChoice;
  name?: string; // tag / account 的名字(connector 走 registry 类型名,不用它)
  onPrimary?: boolean; // 落在激活药丸(bg-primary 浅底)上 → logo 底盘随之改色
  className?: string;
}) {
  const { data: catalog } = useQuery(connectorCatalogQuery());
  const id = target.connectorId ?? "";
  const resolvedName =
    target.kind === "connector"
      ? (catalog?.[id]?.label ?? connectorLabelFallback(id))
      : (name ?? "");
  const logo = target.kind === "connector" ? catalog?.[id]?.logo : undefined;
  return (
    <PinTargetMark
      kind={target.kind}
      name={resolvedName}
      logo={logo}
      onPrimary={onPrimary}
      className={className}
    />
  );
}
