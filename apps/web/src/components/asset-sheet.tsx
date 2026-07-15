import {
  Badge,
  BottomSheet,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Drawer,
  LogoAvatar,
  SharedLayoutBg,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useMediaQuery,
} from "@folio/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { WalletIcon } from "lucide-react";
import { useState } from "react";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import { useFormatter, useTranslations } from "use-intl";
import type { Holding } from "../lib/aggregate";
import { dayValueChange } from "../lib/day-value-change";
import { formatNumber } from "../lib/format-number";
import type { HistoryPoint } from "../lib/history";
import { useDisplayValue } from "../lib/hooks/use-display-value";
import { getTokenValueHistory } from "../lib/server/token-history";
import { groupByAccount, groupByPlatform, type SourceGroup } from "../lib/source-groups";
import { AvatarStack } from "./avatar-stack";

// 资产 drill-down 侧边栏(v2):代币头部 + 来源明细。桌面右滑 Drawer、移动 BottomSheet 承载同一份内容。
// 头部背景 = 单币【持仓价值】历史(片 2):折线随涨跌走 --pos/--neg,内容浮其上;可切 7d/30d/1y/全部。
// 来源区是 Platforms / Accounts 两视图的 tab 切换(互为转置):按平台看散在哪些链/场馆,或按账户看散在哪些账户。

const DAY_MS = 86_400_000;
type Range = "7d" | "30d" | "1y" | "all";
const RANGES: Range[] = ["7d", "30d", "1y", "all"];
const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { "7d": 7, "30d": 30, "1y": 365 };

// 价值历史背景图(仿 hero):绝对定位垫底,折线压到下半区,内容浮其上;hover 出 tooltip(时间 + 价值)。
// 内容层 pointer-events-none 让 hover 透传到此图。<2 点不渲染(头部已预留固定高度,故不渲染也不塌陷)。
function TokenValueBackdrop({ series }: { series: HistoryPoint[] }) {
  const usd = useDisplayValue();
  const format = useFormatter();
  if (series.length < 2) return null;
  const up = (series.at(-1)?.total ?? 0) >= (series[0]?.total ?? 0);
  const config = {
    total: { label: "", color: up ? "var(--pos)" : "var(--neg)" },
  } satisfies ChartConfig;
  const fullDateTime = (ms: number) =>
    format.dateTime(new Date(ms), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <ChartContainer config={config} className="absolute inset-0 h-full w-full">
      <AreaChart data={series} margin={{ top: 56, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="asset-value-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-total)" stopOpacity={0.14} />
            <stop offset="100%" stopColor="var(--color-total)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="t" hide />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <ChartTooltip
          cursor={{ stroke: "var(--border-2)", strokeDasharray: "3 3" }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => fullDateTime(Number(payload?.[0]?.payload?.t))}
              formatter={(value) => usd(Number(value))}
            />
          }
        />
        <Area
          dataKey="total"
          type="monotone"
          stroke="var(--color-total)"
          strokeWidth={2}
          strokeOpacity={0.5}
          fill="url(#asset-value-fill)"
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

// 窗口切换:7D / 30D / 1Y / 全部。beUI Tabs(透明底,与来源 tab 同款);无 TabsContent,value 驱动 chart。
function RangeTabs({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const t = useTranslations("Overview");
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as Range)} variant="pill">
      <TabsList className="bg-transparent p-0">
        {RANGES.map((r) => (
          <TabsTrigger key={r} value={r}>
            {r === "all" ? t("rangeAll") : r.toUpperCase()}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

// 组头像:单 avatar → 单 logo;多 avatar(账户跨多链)→ 叠标 + N(共享 AvatarStack)。
// manual 亦有内置 logo(NotebookPen),走普通 LogoAvatar,不再特判。
function GroupAvatar({ group }: { group: SourceGroup }) {
  const [first] = group.avatars;
  if (group.avatars.length === 1 && first) {
    return <LogoAvatar src={first.logo} fallback={first.name} size="sm" />;
  }
  return <AvatarStack items={group.avatars} size="md" />;
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

  // 单币持仓价值历史(片 2):按 Holding key + 窗口拉取,喂头部背景图。窗口切换即重取(keepPrevious 防闪)。
  const [range, setRange] = useState<Range>("30d");
  const since = range === "all" ? undefined : Date.now() - RANGE_DAYS[range] * DAY_MS;
  const historyQuery = useQuery({
    queryKey: ["token-history", holding.key, range],
    queryFn: () => getTokenValueHistory({ data: { key: holding.key, since } }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const series = historyQuery.data?.series ?? [];
  const hasHistory = series.length >= 2;
  const spanDays = hasHistory
    ? Math.round(((series.at(-1)?.t ?? 0) - (series[0]?.t ?? 0)) / DAY_MS)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      {/* 头部 + 窗口切换成组。头部预留固定高度(min-h-44)→ 价值历史图异步到达也不撑高、不挤压下方列表。 */}
      <div className="flex flex-col gap-3">
        {/* 价值历史图垫底(hover 出 tooltip);内容 pointer-events-none 让 hover 透传;右下角天数 ND(仿 hero)。 */}
        <div className="relative min-h-44 overflow-hidden">
          <TokenValueBackdrop series={series} />
          <div className="pointer-events-none relative flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <LogoAvatar src={token.logo} fallback={token.symbol} size="lg" />
              <div className="min-w-0">
                {/* 名称 + 徽标(中性 pill,无状态图标):市值排名 + 价格合一,贴在名称右侧。
                    排名走 text-foreground(深色主题即白、亮色主题自动转深),价格保持 muted。 */}
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate font-semibold text-lg">{token.name}</h2>
                  {(token.marketCapRank != null || token.unitPrice != null) && (
                    <Badge status="neutral" size="sm" showIcon={false}>
                      <span className="inline-flex items-center gap-1">
                        {token.marketCapRank != null && (
                          <span className="text-foreground">#{token.marketCapRank}</span>
                        )}
                        {token.unitPrice != null && <span>{usd(token.unitPrice)}</span>}
                      </span>
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
                <div
                  className={`mt-1 text-sm tabular-nums ${dayValue > 0 ? "text-pos" : "text-neg"}`}
                >
                  {dayValue > 0 ? "+" : "−"}
                  {usd(Math.abs(dayValue))} {Math.abs(change24h ?? 0).toFixed(2)}%
                </div>
              )}
            </div>
          </div>

          {spanDays >= 1 && (
            <span className="absolute right-0 bottom-0 z-10 font-mono text-muted-foreground text-xs tracking-wide">
              {spanDays}D
            </span>
          )}
        </div>

        <RangeTabs value={range} onChange={setRange} />
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
