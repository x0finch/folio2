import { cn, LogoAvatar } from "@folio/ui";
import { useConnectorLabels, useConnectorLogos } from "../hooks/use-connector-labels";
import { connectorLabelFallback } from "../lib/connector-label";
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
//
// —— 为什么这个文件被拆成「已解析」与「查目录」两条 ——
//
// 首页 tab 条的标签是**服务端解析好**再下发的(见 getHomeTabMeta),就是为了让首屏不必再拉
// 连接器目录(#488 票 4)。但 hook 不能条件调用:只要 `useConnectorLabels()` 写在共用组件里,
// 哪怕名字和图都已经传进来了,那次 `useQuery(connectorCatalogQuery())` 照样会发出去 ——
// 「不再拉目录」就成了一句空话(code review 抓到的)。
// 拆成两个组件是唯一干净的治法:走已解析那条时,查目录的 hook 根本不挂载。

function ConnectorMarkView({
  logo,
  fallback,
  onPrimary,
}: {
  logo?: string;
  fallback: string;
  onPrimary?: boolean;
}) {
  return (
    <LogoAvatar
      src={logo}
      fallback={fallback}
      size="sm"
      className={cn("mr-1 size-3.5", onPrimary && "ring-1 ring-primary-foreground/40")}
    />
  );
}

// 查目录那条:调用方没给名字/图时才挂载,于是只有它会触发连接器目录那个查询。
function ConnectorMarkLookup({
  connectorId,
  onPrimary,
}: {
  connectorId: string;
  onPrimary?: boolean;
}) {
  const logoOf = useConnectorLogos();
  const labelOf = useConnectorLabels();
  return (
    <ConnectorMarkView
      logo={logoOf(connectorId)}
      fallback={labelOf(connectorId)}
      onPrimary={onPrimary}
    />
  );
}

// 同上,名字那半:没给 `name` 的 connector 目标才挂载。
function ConnectorTextLookup({ connectorId }: { connectorId: string }) {
  const labelOf = useConnectorLabels();
  return <>{labelOf(connectorId)}</>;
}

export function PinTargetLabel({
  target,
  name,
  logo,
  onPrimary,
  className,
}: {
  target: PinTargetChoice;
  /**
   * 显示名。tag / account 一向走这里;**connector 也可以走** —— 首页 tab 条的标签是服务端
   * 解析好的(见 getHomeTabMeta),传进来就不必再去客户端那份连接器目录里查。
   *
   * **服务端认不出时必须不传(undefined),不能传空串** —— 下面用的是 `??`,空串不是 nullish,
   * 回退不会触发,标签会渲染成一个空 tab。
   */
  name?: string;
  /** connector 的图,同样可由调用方直接给。不给则去目录里查(选择器那两处)。 */
  logo?: string;
  onPrimary?: boolean; // 落在激活药丸(bg-primary 浅底)上 → logo 底盘随之改色,见 ConnectorMarkView
  className?: string;
}) {
  const connectorId = target.connectorId ?? "";
  return (
    <span className={cn("flex min-w-0 items-center", className)}>
      {/* aria-hidden:标记是纯装饰,名字紧跟其后。不隐则 Avatar 的首字母 fallback 会混进
          可访问名,tab 读作 "MManual"(实测)。 */}
      {target.kind === "connector" && (
        <span aria-hidden className="flex">
          {logo != null || name != null ? (
            // 名字或图任一由服务端给了 → 走纯渲染那条,不碰目录。首字母兜底用 name(有就用),
            // 否则用与目录同一套的 `connectorLabelFallback`,而不是把裸 id 印上去(#467)。
            <ConnectorMarkView
              logo={logo}
              fallback={name ?? connectorLabelFallback(connectorId)}
              onPrimary={onPrimary}
            />
          ) : (
            <ConnectorMarkLookup connectorId={connectorId} onPrimary={onPrimary} />
          )}
        </span>
      )}
      {/* `#`/`@` 紧贴名字(同 TagBadges 的 `#name`),logo 才用 gap 隔开 —— 符号是名字的一部分,图不是。 */}
      <span className="min-w-0 truncate">
        {target.kind === "tag" ? "#" : target.kind === "account" ? "@" : ""}
        {name ??
          (target.kind === "connector" ? <ConnectorTextLookup connectorId={connectorId} /> : "")}
      </span>
    </span>
  );
}
