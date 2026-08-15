import { useConnectorLabels, useConnectorLogos } from "../../../../hooks/use-connector-labels";
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
  const labelOf = useConnectorLabels();
  const logoOf = useConnectorLogos();
  const resolvedName =
    target.kind === "connector" ? labelOf(target.connectorId ?? "") : (name ?? "");
  const logo = target.kind === "connector" ? logoOf(target.connectorId ?? "") : undefined;
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
