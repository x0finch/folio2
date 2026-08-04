import { cn, LogoAvatar } from "@folio/ui";
import { useConnectorLabels, useConnectorLogos } from "../hooks/use-connector-labels";
import type { PinTargetChoice } from "./tab-pin-picker";

// 自定义 Tab 的目标标签(#351 ②):**一个符号 = 一种身份** —— tag `#名`、account `@名`、
// connector `logo + 类型名`(binance / zerion…,非账户自定义名)。pin 药丸与选择器三段共用同一份渲染,
// 两处标记必然一致。`#`/`@` 是纯展示前缀,永不入库。
//
// connector 前导位:全站统一的 LogoAvatar —— 有图显图、无图回退**首字母圆标**(与代币行/来源行同一件,
// 不另造形状)。缩到 size-3.5(≈ text-sm 的视高)+ mr-1,与紧贴名字的 `#`/`@` 字符同高,pill 里不高低不齐。
//
// onPrimary:药丸激活时底衬是浅色的 bg-primary,logo 默认那块恒亮白盘就成了「白上叠白」的第二块白 →
// 整件跟着表面走 —— 盘子与圆底都换成药丸自身的颜色(视觉上消失,但仍是不透明实底,透明 logo 不漏出
// 底下的 fallback 字母;根也得一起换,否则圆边缘抗锯齿处漏出 bg-muted 暗环),首字母改用药丸前景色。
function ConnectorMark({ connectorId, onPrimary }: { connectorId: string; onPrimary?: boolean }) {
  const logoOf = useConnectorLogos();
  const labelOf = useConnectorLabels();
  return (
    <LogoAvatar
      src={logoOf(connectorId)}
      fallback={labelOf(connectorId)}
      size="sm"
      className={cn("mr-1 size-3.5", onPrimary && "bg-primary")}
      plateClassName={onPrimary ? "bg-primary" : undefined}
      fallbackClassName={onPrimary ? "text-primary-foreground" : undefined}
    />
  );
}

export function PinTargetLabel({
  target,
  name,
  onPrimary,
  className,
}: {
  target: PinTargetChoice;
  name?: string; // tag / account 的名字(connector 走 registry 类型名,不用它)
  onPrimary?: boolean; // 落在激活药丸(bg-primary 浅底)上 → logo 底盘随之改色,见 ConnectorMark
  className?: string;
}) {
  const labelOf = useConnectorLabels();
  const text = target.kind === "connector" ? labelOf(target.connectorId ?? "") : (name ?? "");
  return (
    <span className={cn("flex min-w-0 items-center", className)}>
      {/* aria-hidden:标记是纯装饰,名字紧跟其后。不隐则 Avatar 的首字母 fallback 会混进
          可访问名,tab 读作 "MManual"(实测)。 */}
      {target.kind === "connector" && (
        <span aria-hidden className="flex">
          <ConnectorMark connectorId={target.connectorId ?? ""} onPrimary={onPrimary} />
        </span>
      )}
      {/* `#`/`@` 紧贴名字(同 TagBadges 的 `#name`),logo 才用 gap 隔开 —— 符号是名字的一部分,图不是。 */}
      <span className="min-w-0 truncate">
        {target.kind === "tag" ? "#" : target.kind === "account" ? "@" : ""}
        {text}
      </span>
    </span>
  );
}
