import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
  Badge,
  BottomSheet,
  Drawer,
  LogoAvatar,
  SharedLayoutBg,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@folio/ui";
import { WalletIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { dayValueChange } from "../lib/day-value-change";
import { formatNumber } from "../lib/format-number";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { useMediaQuery } from "../lib/hooks/use-media-query";
import { groupByAccount, groupByPlatform, type SourceGroup } from "../lib/source-groups";

// 资产 drill-down 侧边栏(v2):代币头部 + 来源明细。桌面右滑 Drawer、移动 BottomSheet 承载同一份内容。
// folio2 无每币行情历史 → 不做币价走势;头部预留背景槽位(片 2 填单币【持仓价值】历史图,见 #121)。
// 来源区是 Platforms / Accounts 两视图的 tab 切换(互为转置):按平台看散在哪些链/场馆,或按账户看散在哪些账户。

const MAX_STACK = 3;

// 组头像:单一 manual → 钱包图标;单 avatar → 单 logo;多 avatar(账户跨多链)→ 叠标 + N。
function GroupAvatar({ group }: { group: SourceGroup }) {
  if (group.isManual) {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <WalletIcon className="size-3.5" />
      </span>
    );
  }
  const [first] = group.avatars;
  if (group.avatars.length === 1 && first) {
    return <LogoAvatar src={first.logo} fallback={first.name} size="sm" />;
  }
  const shown = group.avatars.slice(0, MAX_STACK);
  const extra = group.avatars.length - shown.length;
  return (
    <AvatarGroup className="shrink-0 -space-x-1">
      {shown.map((a) => (
        <Avatar key={a.name} title={a.name} className="size-6">
          <AvatarImage src={a.logo} alt="" className="bg-logo-bg" />
          <AvatarFallback className="text-[9px]">{a.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
      ))}
      {extra > 0 ? (
        <AvatarGroupCount className="size-6 text-[9px]">+{extra}</AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}

// 账户名前置 WalletIcon 微图标(与侧栏「Accounts」导航同图标,便于理解):全抽屉「带钱包图标的 = 账户」,
// 与平台名(有 logo 头像 + 公认名)区分。平台名不加。account slot 由视图决定:平台视图账户在副行、账户视图在主行。
function NameLine({
  text,
  account,
  className,
}: {
  text: string;
  account: boolean;
  className: string;
}) {
  return (
    <span className={`flex min-w-0 items-center gap-1 ${className}`}>
      {account && <WalletIcon className="size-3 shrink-0 text-muted-foreground" />}
      <span className="truncate">{text}</span>
    </span>
  );
}

// 来源组行:左 = 头像 + 主名 / 副名;右 = 数量 + symbol(上)· 占比(下,= 组 value / 总 value)。
// accountSlot 标出哪格是账户(带图标);副名与主名【严格相等】(区分大小写)才省略副行 ——
// 用户可能特意把账户命名为小写 "binance"(≠ 平台 "Binance"),这属不同名字,靠钱包图标区分、照常显示。
function GroupRow({
  group,
  secondary,
  symbol,
  totalValue,
  accountSlot,
}: {
  group: SourceGroup;
  secondary: string;
  symbol: string;
  totalValue: number;
  accountSlot: "primary" | "secondary";
}) {
  const pct = totalValue > 0 ? (group.value / totalValue) * 100 : 0;
  const share = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
  const showSecondary = secondary.length > 0 && secondary !== group.primary;
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
      <GroupAvatar group={group} />
      <span className="flex min-w-0 flex-1 flex-col">
        <NameLine
          text={group.primary}
          account={accountSlot === "primary"}
          className="font-medium text-sm"
        />
        {showSecondary && (
          <NameLine
            text={secondary}
            account={accountSlot === "secondary"}
            className="text-muted-foreground text-xs"
          />
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm tabular-nums">
          {formatNumber(group.amount)} {symbol}
        </span>
        <span className="block text-muted-foreground text-xs tabular-nums">{share}%</span>
      </span>
    </div>
  );
}

// 一个来源视图(平台 / 账户):SharedLayoutBg 承载 hover(与代币行同款移动滑块)。
function SourceView({
  groups,
  countKey,
  symbol,
  totalValue,
}: {
  groups: SourceGroup[];
  countKey: "nAccounts" | "nSources"; // 副行多基数时的 i18n key(平台视图数账户、账户视图数平台)
  symbol: string;
  totalValue: number;
}) {
  const t = useTranslations("Overview");
  return (
    <SharedLayoutBg inset={0} pillClassName="rounded-xl">
      {groups.map((g) => (
        <div key={g.key}>
          <GroupRow
            group={g}
            secondary={g.count === 1 ? (g.single ?? "") : t(countKey, { n: g.count })}
            symbol={symbol}
            totalValue={totalValue}
            // 平台视图(countKey=nAccounts)账户在副行;账户视图(nSources)账户在主行。
            accountSlot={countKey === "nAccounts" ? "secondary" : "primary"}
          />
        </div>
      ))}
    </SharedLayoutBg>
  );
}

function AssetSheetContent({ holding }: { holding: Holding }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const { token, totalValue, totalAmount, change24h, sources } = holding;
  const dayValue = dayValueChange(totalValue, change24h);
  const platformGroups = groupByPlatform(sources);
  const accountGroups = groupByAccount(sources);

  return (
    <div className="flex flex-col gap-6">
      {/* 头部。片 2(#121)在此加单币价值历史背景层(绝对定位垫底 + 内容 relative 浮其上)。 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <LogoAvatar src={token.logo} fallback={token.symbol} size="lg" />
          <div className="min-w-0">
            {/* 名称 + 价格徽标(中性 pill,无状态图标):价格贴在名称右侧。 */}
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate font-semibold text-lg">{token.name}</h2>
              {token.unitPrice != null && (
                <Badge status="neutral" size="sm" showIcon={false}>
                  {usd(token.unitPrice)}
                </Badge>
              )}
            </div>
            {totalAmount != null && (
              <p className="text-muted-foreground text-sm tabular-nums">
                {formatNumber(totalAmount)} {token.symbol}
              </p>
            )}
          </div>
        </div>

        <div>
          <div className="font-bold text-3xl tabular-nums">{usd(totalValue)}</div>
          {dayValue != null && (
            // 24h 增值 + %:共用一个前置符号(同源同号)、同色,与代币行/hero 一致。
            <div className={`mt-1 text-sm tabular-nums ${dayValue > 0 ? "text-pos" : "text-neg"}`}>
              {dayValue > 0 ? "+" : "−"}
              {usd(Math.abs(dayValue))} {Math.abs(change24h ?? 0).toFixed(2)}%
            </div>
          )}
        </div>

        {/* 市值排名(已入库字段;缺则不显)。价格已上移到名称右侧徽标。 */}
        {token.marketCapRank != null && (
          <div className="text-muted-foreground text-sm tabular-nums">
            {t("marketCapRank", { rank: token.marketCapRank })}
          </div>
        )}
      </div>

      {/* 来源:Platforms / Accounts 两视图切换。tab 背景透明,与主页 Tokens/DeFi 一致。 */}
      <Tabs defaultValue="platforms" variant="pill">
        <TabsList className="bg-transparent p-0">
          <TabsTrigger value="platforms">{t("platformsTab")}</TabsTrigger>
          <TabsTrigger value="accounts">{t("accountsTab")}</TabsTrigger>
        </TabsList>
        <TabsContent value="platforms">
          <SourceView
            groups={platformGroups}
            countKey="nAccounts"
            symbol={token.symbol}
            totalValue={totalValue}
          />
        </TabsContent>
        <TabsContent value="accounts">
          <SourceView
            groups={accountGroups}
            countKey="nSources"
            symbol={token.symbol}
            totalValue={totalValue}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function AssetSheet({
  holding,
  open,
  onOpenChange,
}: {
  holding: Holding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // 桌面右滑 Drawer;移动(< sm)用 BottomSheet。两壳复用同一份内容组件。
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        side="right"
        ariaLabel={holding?.token.name}
        className="w-full max-w-md overflow-y-auto p-6"
      >
        {holding && <AssetSheetContent holding={holding} />}
      </Drawer>
    );
  }

  return (
    // title 不传:内容头部已渲染代币名,避免 BottomSheet 自带标题区重复。
    <BottomSheet open={open} onOpenChange={onOpenChange} snapPoints={[0.6, 0.92]}>
      {holding && <AssetSheetContent holding={holding} />}
    </BottomSheet>
  );
}
