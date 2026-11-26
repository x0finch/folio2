import {
  Badge,
  BottomSheet,
  cn,
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

import { type ReactNode, useMemo, useState } from "react";
import { useTranslations } from "use-intl";
import { AccountName } from "@/components/account-name";
import { AmountTicker } from "@/components/amount-ticker";
import { AvatarStack } from "@/components/avatar-stack";
import { type Range, RangeTabs, rangeSince } from "@/components/range-tabs";
import { Sensitive } from "@/components/sensitive";
import { collapseToSlots } from "@/components/tag-badges";
import { formatNumber, signedUsd } from "@/lib/core/format-number";
import type { Holding } from "@/lib/core/portfolio";
import { tokenValueHistoryFromRaw } from "@/lib/core/portfolio";
import { useDisplayValue } from "@/lib/hooks/use-display-value";
import { holdingHistoryQuery } from "@/lib/queries/accounts";
import { SHEET_TREND_HEIGHT, TrendPanel } from "@/routes/_authed/-home/hero/trend-panel";
import { deltaTone, NO_VALUE } from "@/routes/_authed/-home/holdings/value-delta";
import { ACCOUNT_SLOTS, groupByAccount, groupByPlatform, type SourceGroup } from "./source-groups";

// Token drill-down drawer: token header + source breakdown, in a right Drawer on desktop and a
// BottomSheet on mobile. The header background is the token's holding-value history (line follows
// --pos/--neg); sources toggle between Platforms and Accounts (transposed views). The window switch
// (RangeTabs) is shared with the account drawer.

// Group avatars: a single avatar is one logo; several (account across chains) are a stack + N (shared AvatarStack).
function GroupAvatar({ group }: { group: SourceGroup }) {
  const [first] = group.avatars;
  if (group.avatars.length === 1 && first) {
    return <LogoAvatar src={first.logo} fallback={first.name} size="sm" />;
  }
  return <AvatarStack items={group.avatars} size="md" />;
}

// Account names render via <AccountName> (`@name`); platform names don't. The account slot depends
// on the view: platform view puts accounts in the sub-row, account view in the main row.
function NameLine({
  text,
  account,
  className,
}: {
  text: string;
  account: boolean;
  className: string;
}) {
  if (account) return <AccountName name={text} className={className} />;
  return (
    <span className={`flex min-w-0 items-center gap-1 ${className}`}>
      <span className="truncate">{text}</span>
    </span>
  );
}

// Platform-row sub-name: the group's accounts by value descending, folded like account-row tags
// (collapseToSlots). The threshold is source-groups' ACCOUNT_SLOTS, shared so the exact-threshold
// case doesn't silently drop one. `total` is the group's account count (topAccounts is only the top few).
function AccountNames({
  accounts,
  total,
}: {
  accounts: { id: string; label: string }[];
  total: number;
}) {
  const { shown, overflow } = collapseToSlots(accounts, ACCOUNT_SLOTS, total);
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
      {shown.map((a) => (
        <AccountName key={a.id} name={a.label} className="min-w-0" />
      ))}
      {overflow > 0 && <span className="shrink-0">+{overflow}</span>}
    </span>
  );
}

// Source group row: left = avatars + main / sub name; right = amount + symbol over share of total
// value. The sub-row is omitted only when it equals the main name case-sensitively: an account
// named "binance" differs from the platform "Binance" and still shows.
function GroupRow({
  group,
  secondary,
  symbol,
  totalValue,
  accountSlot,
}: {
  group: SourceGroup;
  secondary: ReactNode; // null = omit the sub-row (duplicates the main name)
  symbol: string;
  totalValue: number;
  accountSlot: "primary" | "secondary";
}) {
  const pct = totalValue > 0 ? (group.value / totalValue) * 100 : 0;
  const share = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-3">
      <GroupAvatar group={group} />
      <span className="flex min-w-0 flex-1 flex-col">
        <NameLine
          text={group.primary}
          account={accountSlot === "primary"}
          className="font-medium text-sm"
        />
        {secondary}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm tabular-nums">
          <Sensitive>{formatNumber(group.amount)}</Sensitive> {symbol}
        </span>
        <span className="block text-muted-foreground text-xs tabular-nums">{share}%</span>
      </span>
    </div>
  );
}

// One source view (platform / account): SharedLayoutBg carries the hover slider, as the token rows do.
function SourceView({
  groups,
  countKey,
  symbol,
  totalValue,
}: {
  groups: SourceGroup[];
  countKey: "nAccounts" | "nSources"; // i18n key for the sub-row cardinality
  symbol: string;
  totalValue: number;
}) {
  const t = useTranslations("Overview");
  const platformView = countKey === "nAccounts"; // sub-dimension is accounts: name them; the account view still reports a count
  // Sub-name equal to the main name (case-sensitive) omits the sub-row; "binance" vs "Binance"
  // differ and are told apart by `@`.
  const secondaryFor = (g: SourceGroup) => {
    if (g.count === 1) {
      const only = g.single ?? "";
      if (!only || only === g.primary) return null;
      return platformView ? (
        <AccountNames accounts={g.topAccounts} total={g.count} />
      ) : (
        <NameLine text={only} account={false} className="text-muted-foreground text-xs" />
      );
    }
    return platformView ? (
      <AccountNames accounts={g.topAccounts} total={g.count} />
    ) : (
      <NameLine
        text={t(countKey, { n: g.count })}
        account={false}
        className="text-muted-foreground text-xs"
      />
    );
  };
  return (
    <SharedLayoutBg inset={0} pillClassName="rounded-xl">
      {groups.map((g) => (
        <div key={g.key}>
          <GroupRow
            group={g}
            secondary={secondaryFor(g)}
            symbol={symbol}
            totalValue={totalValue}
            // Platform view (nAccounts) puts accounts in the sub-row; account view (nSources) in the main row.
            accountSlot={platformView ? "secondary" : "primary"}
          />
        </div>
      ))}
    </SharedLayoutBg>
  );
}

function TokenSheetContent({ holding }: { holding: Holding }) {
  const t = useTranslations("Overview");
  const usd = useDisplayValue();
  const { token, totalValue, totalAmount, sources } = holding;
  // 24h PnL computed server-side, the same number as the home row.
  const dayValue = holding.gain24h?.amount ?? null;
  const dayPct = holding.gain24h?.pct ?? null;
  const platformGroups = groupByPlatform(sources);
  const accountGroups = groupByAccount(sources);

  // Holding-value history by holding key + window, feeding the header background; keepPrevious avoids flashing on window switch.
  const [range, setRange] = useState<Range>("30d");
  const since = rangeSince(range, Date.now());
  const historyQuery = useQuery({
    ...holdingHistoryQuery({ holdingKey: holding.key, range, since }),
    placeholderData: keepPreviousData,
  });
  // The curve is drawn in the browser from the raw balance rows in the window.
  const series = useMemo(
    () => (historyQuery.data == null ? [] : tokenValueHistoryFromRaw(historyQuery.data)),
    [historyQuery.data],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <LogoAvatar src={token.logo} fallback={token.symbol} size="lg" />
            <div className="min-w-0">
              {/* Name + badge (neutral pill): market-cap rank + price beside the name; rank uses
                    text-foreground, price stays muted. */}
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
                  <Sensitive>{formatNumber(totalAmount)}</Sensitive> {token.symbol}
                </p>
              )}
            </div>
          </div>

          <div>
            {/* Rolling and integer/decimal split use AmountTicker (shared with hero and account drawer). */}
            <AmountTicker
              value={totalValue}
              className="font-bold text-3xl"
              fractionClassName="font-bold text-muted-foreground text-xl tabular-nums"
            />
            {/* 24h PnL + %: one shared prefix and color, like token rows / hero. Not computable -> `—`. */}
            {holding.gain24h == null ? (
              <div className={cn("mt-1 text-sm tabular-nums", deltaTone(null))}>{NO_VALUE}</div>
            ) : (
              <div className={cn("mt-1 text-sm tabular-nums", deltaTone(dayValue))}>
                {/* Masks the PnL amount, keeps the percentage. */}
                <Sensitive>{signedUsd(usd, dayValue ?? 0)}</Sensitive>
                {dayPct != null ? ` ${Math.abs(dayPct).toFixed(2)}%` : ""}
              </div>
            )}
          </div>
        </div>
        {/* Fixed height so the async chart doesn't resize the list. */}
        <div className="relative mt-6 h-32">
          <TrendPanel
            series={series}
            height={SHEET_TREND_HEIGHT}
            loading={historyQuery.isPending}
          />
        </div>
        <div className="mt-2 flex justify-end">
          <RangeTabs value={range} onChange={setRange} />
        </div>
      </div>

      {/* Sources: Platforms / Accounts toggle; tab background transparent like home Tokens/DeFi. */}
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

export function TokenSheet({
  holding,
  open,
  onOpenChange,
}: {
  holding: Holding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Desktop: right Drawer; mobile (< sm): BottomSheet; both share one content component.
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
        {holding && <TokenSheetContent holding={holding} />}
      </Drawer>
    );
  }

  return (
    // No title: the header already renders the token name.
    <BottomSheet open={open} onOpenChange={onOpenChange} snapPoints={[0.6, 0.92]}>
      {holding && <TokenSheetContent holding={holding} />}
    </BottomSheet>
  );
}
