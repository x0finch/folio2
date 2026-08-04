import { cn, LogoAvatar } from "@folio/ui";
import { useConnectorLabels, useConnectorLogos } from "../hooks/use-connector-labels";
import type { PinTargetChoice } from "./tab-pin-picker";

// 自定义 Tab 的目标标签(#351 ②):**一个符号 = 一种身份** —— tag `#名`、account `@名`、
// connector `logo + 类型名`(binance / zerion…,非账户自定义名)。pin 药丸与选择器三段共用同一份渲染,
// 两处标记必然一致。`#`/`@` 是纯展示前缀,永不入库。
//
// connector 前导位:全站统一的 LogoAvatar —— 有图显图、无图回退**首字母圆标**(与代币行/来源行同一件,
// 不另造形状)。缩到 size-3.5(≈ text-sm 的视高)+ mr-1,与紧贴名字的 `#`/`@` 字符同高,pill 里不高低不齐。
function ConnectorMark({ connectorId }: { connectorId: string }) {
  const logoOf = useConnectorLogos();
  const labelOf = useConnectorLabels();
  return (
    <LogoAvatar
      src={logoOf(connectorId)}
      fallback={labelOf(connectorId)}
      size="sm"
      className="mr-1 size-3.5"
    />
  );
}

export function PinTargetLabel({
  target,
  name,
  className,
}: {
  target: PinTargetChoice;
  name?: string; // tag / account 的名字(connector 走 registry 类型名,不用它)
  className?: string;
}) {
  const labelOf = useConnectorLabels();
  const text = target.kind === "connector" ? labelOf(target.connectorId ?? "") : (name ?? "");
  return (
    <span className={cn("flex min-w-0 items-center", className)}>
      {target.kind === "connector" && <ConnectorMark connectorId={target.connectorId ?? ""} />}
      {/* `#`/`@` 紧贴名字(同 TagBadges 的 `#name`),logo 才用 gap 隔开 —— 符号是名字的一部分,图不是。 */}
      <span className="min-w-0 truncate">
        {target.kind === "tag" ? "#" : target.kind === "account" ? "@" : ""}
        {text}
      </span>
    </span>
  );
}
