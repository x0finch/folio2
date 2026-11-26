import type { Note } from "@folio/connectors-basic";
import {
  BouncyAccordion,
  type BouncyAccordionItem,
  SharedLayoutBg,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@folio/ui";
import { useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import {
  type AccountSections,
  type OverviewBalance,
  type SpotRow,
  toAccountSections,
} from "@/lib/core/account-view";
import { formatNumber } from "@/lib/core/format-number";
import { DefiPositions } from "@/routes/_authed/-home/holdings/defi";
import { PerpPositions } from "@/routes/_authed/-home/holdings/perp";
import { TokenRowContent } from "@/routes/_authed/-home/holdings/tokens/token-row";
import { NoteIconGlyph, NoteIndicator, NoteView } from "./notes";

// Card-list holdings for the account drawer (narrow containers); the overview page uses -home/holdings.
// Account-level notes render as a BouncyAccordion at the top, balance-level notes as a
// <NoteIndicator> beside the spot row title. Spot rows reuse the home <TokenRowContent>, sorted by USD value.
function SpotCards({ rows, gainPending }: { rows: SpotRow[]; gainPending: boolean }) {
  const fmtNote = useNoteFormatNumber();
  const sorted = [...rows].sort((a, b) => b.usdValue - a.usdValue);
  return (
    <SharedLayoutBg inset={0} pillClassName="rounded-xl bg-muted">
      {sorted.map((b) => (
        // Lift the row above siblings while its note popover is open (else the next row's z-10 content covers it).
        <div key={b.id} className="rounded-xl px-3 py-3 has-[[data-state=open]]:z-20">
          <TokenRowContent
            item={{
              logo: b.logo,
              name: b.name ?? b.symbol.toUpperCase(),
              symbol: b.symbol.toUpperCase(),
              amount: b.amount,
              value: b.usdValue,
              // No `?? null`: archived accounts' spot rows carry `undefined`, which must not collapse into
              // "uncomputable" and render `—`; pass the three states through (see -home/holdings/value-delta).
              gain24h: b.gain24h,
            }}
            aside={b.note ? <NoteIndicator note={b.note} formatNumber={fmtNote} /> : undefined}
            gainPending={gainPending}
          />
        </div>
      ))}
    </SharedLayoutBg>
  );
}

// Wiring for <NoteView>/<NoteIndicator>: locale number formatting is injected so the render package
// doesn't depend on use-intl / @folio/fx.
function useNoteFormatNumber(): (n: number) => string {
  const locale = useLocale();
  return (n: number) => formatNumber(n, { compact: false, maxFractionDigits: 8, locale });
}

function AccountNoteAccordion({ notes }: { notes: Note[] }) {
  const fmtNote = useNoteFormatNumber();
  if (notes.length === 0) return null;
  const items: BouncyAccordionItem[] = notes.map((n, i) => ({
    // Notes have no stable id; the index doubles as the accordion key (the list never reorders).
    id: String(i),
    icon: <NoteIconGlyph icon={n.icon} />,
    title: n.title,
    description: <NoteView note={n} hideHeader formatNumber={fmtNote} />,
  }));
  return <BouncyAccordion items={items} classNames={{ description: "text-foreground" }} />;
}

// Sections: the first three are spot, split by note.group into wallets (CEX multi-wallet); other
// spot has no group and falls under spot.
type HoldingTab = "tokens" | "funding" | "earn" | "perps" | "defi";

// A perp section needs positions or equity >= this, so a dust-equity empty futures wallet gets no tab.
const PERP_MIN_USD = 1;

// funding -> Funding, earn -> Earn, everything else -> Spot. Couples to the providers' group values
// (binance funding/earn); the single read point for wallet grouping.
interface SpotWalletGroups {
  spot: SpotRow[];
  funding: SpotRow[];
  earn: SpotRow[];
}
function toSpotWalletGroups(rows: SpotRow[]): SpotWalletGroups {
  const groups: SpotWalletGroups = { spot: [], funding: [], earn: [] };
  for (const r of rows) {
    const g = r.note?.group;
    if (g === "funding") groups.funding.push(r);
    else if (g === "earn") groups.earn.push(r);
    else groups.spot.push(r);
  }
  return groups;
}

function availableHoldingTabs(sections: AccountSections, spot: SpotWalletGroups): HoldingTab[] {
  const perpHasContent =
    !!sections.perp &&
    (sections.perp.positions.length > 0 ||
      (sections.perp.equity?.accountValue ?? 0) >= PERP_MIN_USD);
  return [
    spot.spot.length > 0 && "tokens",
    spot.funding.length > 0 && "funding",
    spot.earn.length > 0 && "earn",
    perpHasContent && "perps",
    sections.defi.length > 0 && "defi",
  ].filter(Boolean) as HoldingTab[];
}

function HoldingSection({
  tab,
  sections,
  spot,
  gainPending,
}: {
  tab: HoldingTab;
  sections: AccountSections;
  spot: SpotWalletGroups;
  gainPending: boolean;
}) {
  if (tab === "tokens") return <SpotCards rows={spot.spot} gainPending={gainPending} />;
  if (tab === "funding") return <SpotCards rows={spot.funding} gainPending={gainPending} />;
  if (tab === "earn") return <SpotCards rows={spot.earn} gainPending={gainPending} />;
  // Single account: no accountLabel, DeFi uses this account's groups directly.
  if (tab === "defi") return <DefiPositions groups={sections.defi} hideHeader />;
  return sections.perp ? <PerpPositions view={sections.perp} hideHeader /> : null;
}

function HoldingTabs({
  tabs,
  sections,
  spot,
  gainPending,
}: {
  tabs: HoldingTab[];
  sections: AccountSections;
  spot: SpotWalletGroups;
  gainPending: boolean;
}) {
  const t = useTranslations("Overview");
  const [tab, setTab] = useState<string>(tabs[0]);
  // A selected tab that vanished after a data change falls back to the first available.
  const activeTab = tabs.includes(tab as HoldingTab) ? tab : tabs[0];
  const label: Record<HoldingTab, string> = {
    tokens: t("tokensTab"),
    funding: t("fundingTab"),
    earn: t("earnTab"),
    perps: t("perpsTab"),
    defi: t("defiTab"),
  };
  return (
    <Tabs value={activeTab} onValueChange={setTab} variant="pill" className="flex flex-col gap-4">
      {/* Overrides beUI's pill track background via twMerge (vendored className stays untouched). */}
      <TabsList className="bg-transparent p-0">
        {tabs.map((k) => (
          <TabsTrigger key={k} value={k}>
            {label[k]}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((k) => (
        <TabsContent key={k} value={k}>
          <HoldingSection tab={k} sections={sections} spot={spot} gainPending={gainPending} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function AccountHoldingsCards({
  balances,
  accountNote,
  gainPending = false,
}: {
  balances: OverviewBalance[];
  accountNote?: Note[];
  /** 24h PnL still loading: the spot rows' delta slot shows a small skeleton. */
  gainPending?: boolean;
}) {
  const t = useTranslations("Overview");
  const sections = toAccountSections(balances);
  const spot = toSpotWalletGroups(sections.spot);
  const tabs = availableHoldingTabs(sections, spot);
  const hasNote = (accountNote?.length ?? 0) > 0;
  // No sections and no account note: distinguish "no snapshot" from "balances all zero/dust".
  if (tabs.length === 0 && !hasNote) {
    return (
      <p className="text-sm text-muted-foreground">
        {balances.length === 0 ? t("noSnapshot") : t("onlyDustHoldings")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {/* Account-level note accordion at the top, if any. */}
      {accountNote && accountNote.length > 0 && <AccountNoteAccordion notes={accountNote} />}
      {tabs.length === 1 && (
        <HoldingSection tab={tabs[0]} sections={sections} spot={spot} gainPending={gainPending} />
      )}
      {tabs.length > 1 && (
        <HoldingTabs tabs={tabs} sections={sections} spot={spot} gainPending={gainPending} />
      )}
    </div>
  );
}
