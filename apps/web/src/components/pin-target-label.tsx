import { cn } from "@folio/ui";
import { useConnectorLabels, useConnectorLogos } from "../hooks/use-connector-labels";
import type { PinTargetChoice } from "./tab-pin-picker";

// 自定义 Tab 的目标标签(#351 ②):**一个符号 = 一种身份** —— tag `#名`、account `@名`、
// connector `logo + 类型名`(binance / zerion…,非账户自定义名)。pin 药丸与选择器三段共用同一份渲染,
// 两处标记必然一致。`#`/`@` 是纯展示前缀,永不入库。
//
// logo 前导位 size-3.5(≈ text-sm 的视高)+ mr-1:与紧贴名字的 `#`/`@` 字符在同一视高上,pill 里不高低不齐。
const MARK = "mr-1 flex size-3.5 shrink-0 items-center justify-center";

// connector logo;无图(含 manual、目录未到位)回退首字母方块 —— 不留空、不破坏对齐。
function ConnectorMark({ connectorId }: { connectorId: string }) {
  const logoOf = useConnectorLogos();
  const labelOf = useConnectorLabels();
  const src = logoOf(connectorId);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className={cn(MARK, "rounded-sm bg-logo-bg object-contain")}
        aria-hidden
      />
    );
  }
  return (
    <span aria-hidden className={cn(MARK, "rounded-sm bg-muted font-medium text-[9px] uppercase")}>
      {labelOf(connectorId).slice(0, 1)}
    </span>
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
