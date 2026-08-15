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
// onPrimary:药丸激活时底衬是浅色的 bg-primary,而 logo 可能自己就是浅色(OKX 的图自带白底、
// manual 是透明线稿)→ 一圈发丝边把它与药丸分开。**只有描边对任意 logo 都成立** —— 改 logo 底盘的
// 颜色管不了图片自己烧进去的底色(实测:manual 好了,OKX 照旧白叠白)。深色药丸上不需要,logo 自带的
// 亮底盘已经把它与底面分开了。
function ConnectorMark({
  connectorId,
  logo,
  onPrimary,
}: {
  connectorId: string;
  logo?: string;
  onPrimary?: boolean;
}) {
  const logoOf = useConnectorLogos();
  const labelOf = useConnectorLabels();
  return (
    <LogoAvatar
      src={logo ?? logoOf(connectorId)}
      fallback={labelOf(connectorId)}
      size="sm"
      className={cn("mr-1 size-3.5", onPrimary && "ring-1 ring-primary-foreground/40")}
    />
  );
}

export function PinTargetLabel({
  target,
  name,
  logo,
  onPrimary,
  className,
}: {
  target: PinTargetChoice;
  // 显示名。tag / account 一向走这里;**connector 也可以走**——首页 tab 条的标签是服务端解析好的
  // (见 getHomeTabMeta),传进来就不必再去客户端那份连接器目录里查。不传则照旧查目录(选择器那两处)。
  name?: string;
  // connector 的图,同样可由调用方直接给。首页把连接器目录移出了首屏,不给它就只能回退首字母。
  logo?: string;
  onPrimary?: boolean; // 落在激活药丸(bg-primary 浅底)上 → logo 底盘随之改色,见 ConnectorMark
  className?: string;
}) {
  const labelOf = useConnectorLabels();
  const text = name ?? (target.kind === "connector" ? labelOf(target.connectorId ?? "") : "");
  return (
    <span className={cn("flex min-w-0 items-center", className)}>
      {/* aria-hidden:标记是纯装饰,名字紧跟其后。不隐则 Avatar 的首字母 fallback 会混进
          可访问名,tab 读作 "MManual"(实测)。 */}
      {target.kind === "connector" && (
        <span aria-hidden className="flex">
          <ConnectorMark connectorId={target.connectorId ?? ""} logo={logo} onPrimary={onPrimary} />
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
