import type { Note } from "@folio/connectors-basic";
import type { AccountSafe, SnapshotWithBalances, TabPin, Tag } from "@folio/db";
import {
  fiatCodeOf,
  type PlatformMeta,
  type TokenRecord,
  type TokenRecordPrice,
  type ValuationMode,
  valuate,
} from "@folio/oracle-basic";
import {
  DEFI_FALLBACK_PROTOCOL,
  type DefiGroup,
  defiGainKey,
  mergeDefiGroups,
  type OverviewBalance,
  parseDefiMeta,
  toAccountSections,
} from "@/lib/core/account-view";
import { pinsInView } from "@/lib/core/accounts-in-view";
import { isFungible, type ViewKind, viewKind } from "@/lib/core/balance-kind";
import {
  buildPortfolioHistory,
  downsampleSeries,
  type HistoryPoint,
  minMaxDownsampleHistory,
  type SnapshotTotalRow,
} from "@/lib/core/history";
import {
  connectorLabelFallback,
  platformLogoUrl,
  tokenLogoUrl,
  toLogoSource,
} from "@/lib/core/logo";
import { displayTokenId, type TokenEnrichment } from "@/lib/core/token-model";

// Pure computation for the home/portfolio views (no Effect, Oracle or env): every read path,
// sync finish and backfill calls this, so the math is defined once.

// Minimal slice the browser receives; the server's full `SnapshotWithBalances` also satisfies it,
// so both paths share the same arithmetic.
export interface SnapshotSlice {
  snapshot: { takenAt: number };
  balances: OverviewBalance[];
}

const balancesOf = (byAccount: ReadonlyMap<string, SnapshotSlice>, id: string): OverviewBalance[] =>
  byAccount.get(id)?.balances ?? [];

// Slim enrichment shape: no upstream logo URL, only whether one exists; the proxy URL is derived
// from the token id.
export interface TokenView {
  id: string;
  symbol: string;
  name: string;
  price?: TokenRecordPrice;
  hasLogo: boolean;
}

// Both server-side and browser computation narrow through here, so they get identical inputs.
export function toTokenView(r: TokenRecord): TokenView {
  const { hasLogo } = toLogoSource(r);
  return { id: r.id, symbol: r.symbol, name: r.name, price: r.price, hasLogo };
}

// `hasRef` keeps the price-refresh gate aligned with enrichment.
export type TokenEnrichmentView = TokenView & { hasRef: boolean };

export function toTokenEnrichmentView(r: TokenRecord): TokenEnrichmentView {
  return { ...toTokenView(r), hasRef: r.ref != null };
}

const enrichmentFromView = (tv: TokenEnrichmentView): TokenEnrichment => ({
  symbol: tv.symbol,
  name: tv.name,
  logo: tokenLogoUrl(tv),
  unitPrice: tv.price?.unitPrice,
  marketCapRank: tv.price?.marketCapRank,
});

// Repriced on read, never stored. A null `selfPrice` means mark-to-market (manual/bitcoin);
// a number means enrich-not-reprice (selfPrice = value/amount at sync). Falls back to the frozen
// usdValue when no source price is available.
export interface RevaluableBalance {
  amount: number;
  usdValue: number;
  selfPrice?: number | null;
}

export function liveValue(
  b: RevaluableBalance,
  sourcePrice: number | undefined,
  mode: ValuationMode,
): number {
  const v = valuate(b.amount, b.selfPrice ?? undefined, sourcePrice, mode);
  return v?.value ?? b.usdValue;
}

// Inlined copy of `fungibleTokenId`'s rule so this pure core doesn't depend on the server layer.
const fungibleId = (b: OverviewBalance): string | null =>
  isFungible(viewKind(b)) ? (b.tokenId ?? null) : null;

// Shared by the home total and the chart's live point so they always match.
export const deriveLiveAccountTotals = (
  accounts: AccountSafe[],
  byAccount: ReadonlyMap<string, SnapshotSlice>,
  // Structural so both `TokenView` and a full `TokenRecord` fit.
  enriched: ReadonlyMap<string, { price?: TokenRecordPrice }>,
  mode: ValuationMode,
): Map<string, number> => {
  const priceOf = (b: OverviewBalance): number | undefined => {
    const id = fungibleId(b);
    return id ? enriched.get(id)?.price?.unitPrice : undefined;
  };
  const totals = new Map<string, number>();
  for (const account of accounts) {
    let total = 0;
    for (const b of balancesOf(byAccount, account.id)) total += liveValue(b, priceOf(b), mode);
    totals.set(account.id, total);
  }
  return totals;
};

// 24h gain = value now − value 24h ago (pct base: the start value). Deposits and withdrawals show up
// in the day's gain by design, so it agrees with the net-worth curve. No start snapshot in
// [now-7d, now-24h] → no baseline.

// Rolling 24h, not a calendar day: crypto never closes and "midnight" has no time zone.
export const GAIN_WINDOW_MS = 24 * 60 * 60 * 1000;
// Disconnected over 7 days → no baseline (rather than inflating with a very old value).
export const GAIN_START_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;

export interface Gain {
  amount: number;
  pct: number | null;
}

/**
 * `null` (no observation 24h ago, rendered `—`) must stay distinct from `{ amount: 0 }`. A start
 * ≤ 0 (empty start, net DeFi debt) gives `pct: null` but still an amount.
 */
export function endpointGain(start: number | null | undefined, current: number): Gain | null {
  if (start == null) return null;
  const amount = current - start;
  return { amount, pct: start > 0 ? (amount / start) * 100 : null };
}

export type PrevSlice = SnapshotSlice;

interface StartAggregates {
  accountTotal: Map<string, number>;
  token: Map<string, number>;
  tokenByAccount: Map<string, number>;
  defi: Map<string, number>;
}

const startAggregates = (prevByAccount: ReadonlyMap<string, PrevSlice>): StartAggregates => {
  const accountTotal = new Map<string, number>();
  const token = new Map<string, number>();
  const tokenByAccount = new Map<string, number>();
  const defi = new Map<string, number>();
  for (const [accountId, slice] of prevByAccount) {
    let total = 0;
    for (const b of slice.balances) {
      total += b.usdValue;
      const vk = viewKind(b);
      if (vk === "defi") {
        const protocol = parseDefiMeta(b.metaJson ?? null).protocol ?? DEFI_FALLBACK_PROTOCOL;
        const key = defiGainKey(accountId, protocol);
        defi.set(key, (defi.get(key) ?? 0) + b.usdValue);
        continue;
      }
      // Same rule as the overview aggregate (`isFungible`), so both endpoints compare like with like.
      if (b.tokenId == null || !isFungible(vk)) continue;
      token.set(b.tokenId, (token.get(b.tokenId) ?? 0) + b.usdValue);
      const line = `${accountId} ${b.tokenId}`;
      tokenByAccount.set(line, (tokenByAccount.get(line) ?? 0) + b.usdValue);
    }
    accountTotal.set(accountId, total);
  }
  return { accountTotal, token, tokenByAccount, defi };
};

// Two cases only, at every level (account, portfolio, holding, DeFi): with a baseline, subtract
// endpoints; without one (new account, or disconnected > 7 days), `—`.

// Only for rows without a token_id.
const norm = (s: string): string => s.trim().toUpperCase();

export interface AggInput {
  id?: string; // balance row id; group key only for rows without token_id
  symbol: string;
  amount: number;
  value: number; // USD, provider-authoritative; aggregation sums this
  kind: string;
  platform?: string | null;
  account: { id: string; label: string; connectorId: string; platform?: string | null };
  // Token row id fixed at snapshot write time.
  tokenId?: string | null;
  name?: string;
  logo?: string; // already resolved through the fallback chain
  isFiat?: boolean;
  unitPrice?: number;
  marketCapRank?: number;
}

export interface HoldingSource {
  platform: { id: string; name: string; logo?: string };
  account: { id: string; label: string };
  amount: number;
  value: number;
  kind: string;
}
export interface Holding {
  key: string;
  token: {
    id?: string;
    symbol: string;
    name: string;
    logo?: string;
    unitPrice?: number;
    marketCapRank?: number;
    isFiat?: boolean;
  };
  totalValue: number;
  totalAmount?: number; // sum across sources; only set when the group is a single token
  // Computed by the read path, not here.
  gain24h?: Gain | null;
  sources: HoldingSource[];
}

// Rows without a token_id each form their own group.
function groupKey(row: AggInput): string {
  return row.tokenId ?? `no-token:${row.account.id}:${row.id ?? norm(row.symbol)}`;
}

// Perp equity is never aggregated as a holding.
function isEligible(row: AggInput): boolean {
  return row.kind === "spot";
}

interface Acc {
  key: string;
  first: AggInput;
  totalValue: number;
  totalAmount: number;
  logoHint?: string;
  unitPriceHint?: number;
  marketCapRankHint?: number;
  sources: Map<string, HoldingSource>;
}

// Sorted by value desc.
export function buildCanonicalHoldings(rows: readonly AggInput[]): Holding[] {
  const acc = new Map<string, Acc>();
  for (const row of rows) {
    if (!isEligible(row)) continue;
    const key = groupKey(row);
    let a = acc.get(key);
    if (!a) {
      a = {
        key,
        first: row,
        totalValue: 0,
        totalAmount: 0,
        sources: new Map(),
      };
      acc.set(key, a);
    }
    a.totalValue += row.value;
    a.totalAmount += row.amount;
    if (!a.logoHint && row.logo) a.logoHint = row.logo;
    if (a.unitPriceHint == null && row.unitPrice != null) a.unitPriceHint = row.unitPrice;
    if (a.marketCapRankHint == null && row.marketCapRank != null)
      a.marketCapRankHint = row.marketCapRank;
    // On-chain splits by chain; venues and manual are the connector itself.
    const platformId = row.platform ?? row.account.connectorId;
    const sk = `${row.account.id}|${platformId}`;
    const existing = a.sources.get(sk);
    if (existing) {
      existing.amount += row.amount;
      existing.value += row.value;
    } else {
      a.sources.set(sk, {
        platform: { id: platformId, name: platformId },
        account: { id: row.account.id, label: row.account.label },
        amount: row.amount,
        value: row.value,
        kind: row.kind,
      });
    }
  }

  const holdings: Holding[] = [];
  for (const a of acc.values()) {
    // `=== 0`, not `<= 0`: a negative total (perp blown through) is a real holding.
    if (a.totalValue === 0) continue;
    const sources = [...a.sources.values()].sort((x, y) => y.value - x.value);
    const token = {
      id: a.first.tokenId ?? undefined,
      symbol: a.first.symbol,
      name: a.first.name ?? a.first.symbol,
      logo: a.first.logo ?? a.logoHint,
    };
    holdings.push({
      key: a.key,
      token: {
        id: token.id,
        symbol: token.symbol,
        name: token.name,
        logo: token.logo,
        unitPrice: a.unitPriceHint,
        marketCapRank: a.marketCapRankHint,
        isFiat: a.first.isFiat,
      },
      totalValue: a.totalValue,
      totalAmount: a.totalAmount,
      sources,
    });
  }
  return holdings.sort((x, y) => y.totalValue - x.totalValue);
}

// Per account per bucket spot value for one token; attribution and the spot-only filter run in SQL.
// Long windows (`sampled`) carry bucket min/max/last points and get min-max downsampled.
export interface TokenValueHistoryRaw {
  rows: SnapshotTotalRow[];
  sampled?: boolean;
}

export function tokenValueHistoryFromRaw(raw: TokenValueHistoryRaw): HistoryPoint[] {
  const series = buildPortfolioHistory(raw.rows);
  return raw.sampled ? minMaxDownsampleHistory(series) : downsampleSeries(series);
}

// Input is `toAccountSections` output.
type KindSection = {
  perp: { positions: readonly unknown[]; equity: unknown } | null;
  defi: DefiGroup[];
};

export function kindPresence(sections: KindSection[]): {
  hasPerps: boolean;
  hasDefi: boolean;
} {
  return {
    hasPerps: sections.some(
      (s) => s.perp != null && (s.perp.positions.length > 0 || s.perp.equity != null),
    ),
    hasDefi: mergeDefiGroups(sections).length > 0,
  };
}

// Resolved server-side. `#` / `@` prefixes are added at render time by kind.
export function resolvePinLabel(
  pin: {
    kind: "connector" | "tag" | "account";
    connectorId?: string | null;
    tagId?: string | null;
    accountId?: string | null;
  },
  lookup: {
    tagName: (id: string) => string | undefined;
    accountName: (id: string) => string | undefined;
    connector: (id: string) => { name: string; logo?: string };
  },
): { name: string; logo?: string } {
  if (pin.kind === "tag") return { name: lookup.tagName(pin.tagId ?? "") ?? "" };
  if (pin.kind === "account") return { name: lookup.accountName(pin.accountId ?? "") ?? "" };
  const c = lookup.connector(pin.connectorId ?? "");
  return c.logo ? { name: c.name, logo: c.logo } : { name: c.name };
}

// Accounts and snapshots come from the overview cache, tags from tagListQuery.
export interface PortfolioTabPinsData {
  pins: TabPin[];
  connectorMeta: [string, { name: string; logo?: string }][];
}

export interface HomeTabStripView {
  hasAccounts: boolean;
  hasPerps: boolean;
  hasDefi: boolean;
  pins: {
    id: string;
    kind: "connector" | "tag" | "account";
    connectorId?: string;
    tagId?: string;
    accountId?: string;
    name: string;
    logo?: string;
  }[];
}

export function computeHomeTabStrip(
  snapshot: PortfolioSnapshotData,
  tabPins: PortfolioTabPinsData,
  tags: readonly Tag[],
): HomeTabStripView {
  const accounts = snapshot.accounts;
  const inView = new Set(accounts.map((a) => a.id));
  const snapshotMap = new Map(snapshot.snapshots);
  const sections = [...inView]
    .map((id) => snapshotMap.get(id))
    .filter((s): s is SnapshotView => s != null)
    .map((s) =>
      toAccountSections(
        s.balances.map((b) => ({
          id: b.id,
          amount: b.amount,
          usdValue: b.usdValue,
          kind: b.kind,
          metaJson: b.metaJson,
        })),
      ),
    );
  const { hasPerps, hasDefi } = kindPresence(sections);
  const tagIds = new Set(tags.map((t) => t.id));
  const shownPins = pinsInView(tabPins.pins, { accounts, tagIds });
  const tagName = (id: string) => tags.find((t) => t.id === id)?.name;
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.label;
  const connectorMeta = new Map(tabPins.connectorMeta);
  const connector = (id: string) => connectorMeta.get(id) ?? { name: connectorLabelFallback(id) };

  return {
    hasAccounts: accounts.length > 0,
    hasPerps,
    hasDefi,
    pins: shownPins.map((p) => {
      const label = resolvePinLabel(p, { tagName, accountName, connector });
      return {
        id: p.id,
        kind: p.kind,
        connectorId: p.connectorId ?? undefined,
        tagId: p.tagId ?? undefined,
        accountId: p.accountId ?? undefined,
        name: label.name,
        logo: label.logo,
      };
    }),
  };
}

// Holdings aggregate spot only, across accounts by token; DeFi and perp stay per-account sections.
// Total = Σ each account's live total.

export interface OverviewInput {
  // Supplied by the caller's single assembly, so server and browser feed identical `TokenView`s.
  enriched: ReadonlyMap<string, TokenView>;
  // Same source as the home total and the chart's live point.
  liveTotals: ReadonlyMap<string, number>;
  platformMeta: ReadonlyMap<string, PlatformMeta>;
  // Venue keys use the connector's own name/logo; chain keys return null and use platformMeta.
  connectorMeta?: (key: string) => { name: string; logo?: string } | null;
  // Defaults to self-first.
  mode?: ValuationMode;
  // tokenId → ref under the fiat namer (`fiat/issued:<CODE>`).
  fiatRefs?: ReadonlyMap<string, string>;
  // The "24h ago" snapshot set; omitted → no gain fields. Only membership matters, not `now`.
  prevByAccount?: ReadonlyMap<string, PrevSlice>;
}

interface Elig {
  account: AccountSafe;
  b: OverviewBalance;
}

export interface OverviewView {
  holdings: ReturnType<typeof buildCanonicalHoldings>;
  sections: {
    account: { id: string; label: string; platform?: { name: string; logo?: string } };
    defi: ReturnType<typeof toAccountSections>["defi"];
    perp: ReturnType<typeof toAccountSections>["perp"];
  }[];
  accountTotals: {
    account: { id: string; label: string };
    totalUsd: number;
    takenAt: number | null;
  }[];
  totalUsd: number;
  // Present only when `prevByAccount` was given.
  gain24h?: Gain | null;
  holdingsSubtotal: number;
  defiSubtotal: number;
}

// Excludes perp: enriching perp rows would change decorate's symbol.
export function overviewEnrichIds(
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  // Tokens sold out since 24h ago only appear in the prev set but still need a name and icon.
  prevByAccount?: ReadonlyMap<string, PrevSlice>,
): string[] {
  const ids = new Set<string>();
  for (const group of [byAccount, prevByAccount]) {
    if (!group) continue;
    for (const account of accounts) {
      for (const b of balancesOf(group, account.id)) {
        const vk = viewKind(b);
        if ((vk === "spot" || vk === "defi") && b.tokenId) ids.add(b.tokenId);
      }
    }
  }
  return [...ids];
}

// Venue keys are excluded: connectors supply their own display.
export function overviewChainIds(
  accounts: AccountSafe[],
  byAccount: ReadonlyMap<string, SnapshotSlice>,
  connectorMeta?: (key: string) => { name: string; logo?: string } | null,
): string[] {
  const platformIds = new Set<string>();
  for (const account of accounts) {
    for (const b of balancesOf(byAccount, account.id)) {
      if (isFungible(viewKind(b))) platformIds.add(b.platform ?? account.connectorId);
    }
  }
  return [...platformIds].filter((id) => !connectorMeta?.(id));
}

export function buildOverview(
  accounts: AccountSafe[],
  byAccount: ReadonlyMap<string, SnapshotSlice>,
  {
    enriched,
    liveTotals,
    platformMeta,
    connectorMeta,
    mode = "self-first",
    fiatRefs,
    prevByAccount,
  }: OverviewInput,
): OverviewView {
  // Identity-driven (ref under the fiat namer), not symbol-driven.
  const isFiatToken = (tokenId?: string | null): boolean => {
    const ref = tokenId ? fiatRefs?.get(tokenId) : undefined;
    return ref ? fiatCodeOf(ref) != null : false;
  };

  const eligible: Elig[] = [];
  for (const account of accounts) {
    for (const b of balancesOf(byAccount, account.id)) {
      if (isFungible(viewKind(b))) eligible.push({ account, b });
    }
  }

  const recordOf = (b: { tokenId?: string | null }): TokenView | undefined =>
    b.tokenId ? enriched.get(b.tokenId) : undefined;
  const rows = eligible.map((x) => ({ ...x, e: recordOf(x.b) }));
  const aggInputs: AggInput[] = rows.map(({ account, b, e }) => ({
    id: b.id,
    symbol: e?.symbol ?? "",
    amount: b.amount,
    value: liveValue(b, e?.price?.unitPrice, mode),
    kind: viewKind(b),
    platform: b.platform,
    account: {
      id: account.id,
      label: account.label,
      connectorId: account.connectorId,
      platform: account.platform,
    },
    tokenId: b.tokenId,
    isFiat: isFiatToken(b.tokenId),
    name: e?.name,
    logo: e ? tokenLogoUrl(e) : undefined, // proxied; never an upstream URL
    unitPrice: e?.price?.unitPrice,
    marketCapRank: e?.price?.marketCapRank,
  }));
  const holdings = buildCanonicalHoldings(aggInputs);

  const withGain = prevByAccount != null;
  let portfolioGain: Gain | null | undefined;
  let start: StartAggregates | undefined;
  // Accounts without a baseline (new / disconnected) count on neither side → `—`.
  let prevAccounts: Set<string> | undefined;
  let hasPrevAny = false;
  if (withGain && prevByAccount) {
    const startAgg = startAggregates(prevByAccount);
    start = startAgg;
    const prevAccountIds = new Set(
      accounts.filter((a) => startAgg.accountTotal.has(a.id)).map((a) => a.id),
    );
    prevAccounts = prevAccountIds;
    hasPrevAny = prevAccountIds.size > 0;
    // Only accounts with a baseline count; others stay in totalUsd but not in the gain. None → null.
    let startSum = 0;
    let curSum = 0;
    for (const account of accounts) {
      if (!prevAccountIds.has(account.id)) continue;
      startSum += startAgg.accountTotal.get(account.id) ?? 0;
      curSum += liveTotals.get(account.id) ?? 0;
    }
    portfolioGain = hasPrevAny ? endpointGain(startSum, curSum) : null;
    // Current side uses the same filter as the start side (fungible spot with token_id); otherwise
    // a token also held as DeFi would inflate the gain.
    const curByToken = new Map<string, number>();
    for (const r of aggInputs) {
      if (!prevAccountIds.has(r.account.id)) continue;
      if (r.tokenId == null || !isFungible(r.kind as ViewKind)) continue;
      curByToken.set(r.tokenId, (curByToken.get(r.tokenId) ?? 0) + r.value);
    }
    for (const h of holdings) {
      const id = h.token.id;
      // A token held only by baseline-less accounts has no comparable start → `—`, not $0.
      const hasBase = id != null && (curByToken.has(id) || startAgg.token.has(id));
      h.gain24h =
        hasBase && id != null
          ? endpointGain(startAgg.token.get(id) ?? 0, curByToken.get(id) ?? 0)
          : null;
    }
    // Tokens sold out since 24h ago: add a zero-value row so row gains still sum to the total.
    const listed = new Set(holdings.map((h) => h.token.id));
    for (const [id, startValue] of startAgg.token) {
      if (startValue === 0 || listed.has(id)) continue;
      const e = enriched.get(id);
      holdings.push({
        key: id,
        token: {
          id,
          symbol: e?.symbol ?? "",
          name: e?.name ?? e?.symbol ?? "",
          logo: e ? tokenLogoUrl(e) : undefined,
          unitPrice: e?.price?.unitPrice,
          marketCapRank: e?.price?.marketCapRank,
          isFiat: isFiatToken(id),
        },
        totalValue: 0,
        totalAmount: 0,
        gain24h: endpointGain(startValue, curByToken.get(id) ?? 0),
        sources: [],
      });
    }
  }

  for (const h of holdings) {
    for (const s of h.sources) {
      const cm = connectorMeta?.(s.platform.id);
      if (cm) {
        s.platform.name = cm.name;
        s.platform.logo = platformLogoUrl(s.platform.id, cm.logo);
        continue;
      }
      const m = platformMeta.get(s.platform.id);
      if (m) {
        s.platform.name = m.name;
        s.platform.logo = platformLogoUrl(m.key, m.logo);
      }
    }
  }

  const holdingsSubtotal = holdings.reduce((sum, h) => sum + h.totalValue, 0);

  // Perp equity never enters holdings.
  const decorate = (bs: OverviewBalance[]): OverviewBalance[] =>
    bs.map((b) => ({
      ...b,
      symbol: recordOf(b)?.symbol ?? b.symbol,
    }));

  let defiSubtotal = 0;
  const sections = accounts
    .map((account) => {
      const secs = toAccountSections(decorate(balancesOf(byAccount, account.id)));
      defiSubtotal += secs.defi.reduce(
        (s, g) => s + g.rows.reduce((ss, r) => ss + r.usdValue, 0),
        0,
      );
      const cm = connectorMeta?.(account.connectorId);
      return {
        account: {
          id: account.id,
          label: account.label,
          platform: cm
            ? { name: cm.name, logo: platformLogoUrl(account.connectorId, cm.logo) }
            : undefined,
        },
        defi: secs.defi,
        perp: secs.perp,
      };
    })
    // Equity-only perp accounts are kept.
    .filter(
      (s) =>
        s.defi.length > 0 ||
        (s.perp != null && (s.perp.positions.length > 0 || s.perp.equity != null)),
    );

  if (withGain && start) {
    // `start` is carried so `mergeDefiGroups` can recompute pct across accounts.
    for (const s of sections) {
      const hasPrevAcc = prevAccounts?.has(s.account.id) ?? false;
      for (const g of s.defi) {
        if (!hasPrevAny) {
          g.gain24h = null;
          continue;
        }
        const key = defiGainKey(s.account.id, g.protocol);
        const startVal = hasPrevAcc ? (start.defi.get(key) ?? 0) : 0;
        const current = hasPrevAcc ? g.rows.reduce((sum, r) => sum + r.usdValue, 0) : 0;
        const eg = endpointGain(startVal, current);
        g.gain24h = eg == null ? null : { amount: eg.amount, pct: eg.pct, start: startVal };
      }
    }
  }

  // Live totals were computed at the assembly point.
  const accountTotals = accounts.map((account) => ({
    account: { id: account.id, label: account.label },
    totalUsd: liveTotals.get(account.id) ?? 0,
    takenAt: byAccount.get(account.id)?.snapshot.takenAt ?? null,
  }));
  const totalUsd = accountTotals.reduce((s, r) => s + r.totalUsd, 0);

  return {
    holdings,
    sections,
    accountTotals,
    totalUsd,
    ...(withGain ? { gain24h: portfolioGain } : {}),
    holdingsSubtotal,
    defiSubtotal,
  };
}

// Only the columns the browser computation reads; `snapshotId` and `note` are dropped (the home
// overview never shows balance notes). `metaJson` stays: defi/perp parsing needs it.
export interface BalanceView {
  id: string; // also DefiRow.id; required
  amount: number;
  usdValue: number;
  kind: string;
  selfPrice?: number | null;
  platform?: string | null;
  tokenId?: string | null;
  metaJson: string | null;
}

interface SnapshotView {
  takenAt: number;
  balances: BalanceView[];
}

// Maps travel as entries over the wire; the client rebuilds them and computes the overview.
export interface PortfolioSnapshotData {
  accounts: AccountSafe[];
  snapshots: [string, SnapshotView][];
  prevSnapshots: [string, SnapshotView][];
  enriched: [string, TokenView][];
  platformMeta: [string, PlatformMeta][];
  connectorMeta: [string, { name: string; logo?: string }][];
  fiatRefs: [string, string][];
  mode: ValuationMode;
  // Only the fallback clock for `isFirstSyncPending`. The home page passes the real `Date.now()`:
  // this value is the hour-floored snapshot key anchor and would understate elapsed time by ~1h.
  now: number;
}

const sliceMap = (entries: [string, SnapshotView][]): Map<string, SnapshotSlice> =>
  new Map(
    entries.map(([id, s]) => [id, { snapshot: { takenAt: s.takenAt }, balances: s.balances }]),
  );

// Gains come from subtracting the two snapshot sets; matches `buildOverview` value for value.
export function overviewFromSnapshotData(raw: PortfolioSnapshotData): OverviewView {
  const byAccount = sliceMap(raw.snapshots);
  const prevByAccount = sliceMap(raw.prevSnapshots);
  const enriched = new Map(raw.enriched);
  const platformMeta = new Map(raw.platformMeta);
  const connectorMeta = new Map(raw.connectorMeta);
  const fiatRefs = new Map(raw.fiatRefs);
  const liveTotals = deriveLiveAccountTotals(raw.accounts, byAccount, enriched, raw.mode);
  return buildOverview(raw.accounts, byAccount, {
    enriched,
    liveTotals,
    platformMeta,
    connectorMeta: (key) => connectorMeta.get(key) ?? null,
    mode: raw.mode,
    fiatRefs,
    prevByAccount,
  });
}

// First syncs land within seconds to a minute; 10 minutes is ample margin.
export const FIRST_SYNC_WINDOW_MS = 10 * 60 * 1000;

// A freshly created account with no snapshot at all would render $0, identical to an empty
// portfolio, so the home page shows a loading state instead. "Freshly created" is required: an
// account whose sync always fails (bad creds) would otherwise keep the skeleton forever.
// `now` must be the real wall clock, not the hour-floored key anchor (that would stretch the window
// by up to ~1h).
export function isFirstSyncPending(
  raw: PortfolioSnapshotData | undefined,
  now: number = raw?.now ?? Date.now(),
): boolean {
  if (!raw || raw.accounts.length === 0 || raw.snapshots.length > 0) return false;
  return raw.accounts.some((a) => now - a.createdAt < FIRST_SYNC_WINDOW_MS);
}

export interface AccountGainRow {
  account: { id: string };
  archivedAt: number | null;
  // Frozen latest snapshot total.
  totalUsd: number;
  // Needed so the current side aggregates only fungible spot rows, matching the start side.
  balances: readonly {
    id: string;
    tokenId?: string | null;
    amount: number;
    usdValue: number;
    kind: string;
    metaJson?: string | null;
  }[];
}

export type WithAccountHoldingGain<R extends AccountGainRow> = Omit<R, "balances"> & {
  gain24h?: Gain | null;
  balances: Array<R["balances"][number] & { gain24h?: Gain | null }>;
};

// Same two cases as the portfolio level. Archived accounts get `undefined` at both levels (the UI
// omits the row); non-fungible rows get `undefined` (their sections carry the gain).
export function attachAccountHoldingGains<R extends AccountGainRow>(
  rows: readonly R[],
  prevByAccount: ReadonlyMap<string, PrevSlice>,
): WithAccountHoldingGain<R>[] {
  return rows.map((r): WithAccountHoldingGain<R> => {
    const spotOf = (b: R["balances"][number]): boolean =>
      b.tokenId != null && isFungible(viewKind(b));
    if (r.archivedAt != null) {
      return {
        ...r,
        gain24h: undefined,
        balances: r.balances.map((b) => ({ ...b, gain24h: undefined })),
      };
    }
    const prev = prevByAccount.get(r.account.id);
    // No baseline: account null, spot rows null, other rows undefined.
    if (prev == null) {
      return {
        ...r,
        gain24h: null,
        balances: r.balances.map((b) => ({ ...b, gain24h: spotOf(b) ? null : undefined })),
      };
    }
    let startTotal = 0;
    const startToken = new Map<string, number>();
    for (const b of prev.balances) {
      startTotal += b.usdValue;
      if (b.tokenId != null && isFungible(viewKind(b))) {
        startToken.set(b.tokenId, (startToken.get(b.tokenId) ?? 0) + b.usdValue);
      }
    }
    // One token on several chains is several drawer rows but one gain.
    const curToken = new Map<string, number>();
    const rowsOfToken = new Map<string, number>();
    for (const b of r.balances) {
      if (!spotOf(b)) continue;
      const id = b.tokenId as string;
      curToken.set(id, (curToken.get(id) ?? 0) + b.usdValue);
      rowsOfToken.set(id, (rowsOfToken.get(id) ?? 0) + 1);
    }
    return {
      ...r,
      gain24h: endpointGain(startTotal, r.totalUsd),
      balances: r.balances.map((b): R["balances"][number] & { gain24h?: Gain | null } => {
        if (!spotOf(b)) return { ...b, gain24h: undefined };
        const id = b.tokenId as string;
        const total = curToken.get(id) ?? 0;
        // Missing at start → 0 (bought today).
        const gain = endpointGain(startToken.get(id) ?? 0, total);
        if (gain == null) return { ...b, gain24h: null };
        // Split the token's gain across its rows by value share; if all are 0, split evenly so the
        // gain doesn't vanish.
        const share = total === 0 ? 1 / (rowsOfToken.get(id) ?? 1) : b.usdValue / total;
        return { ...b, gain24h: { amount: gain.amount * share, pct: gain.pct } };
      }),
    };
  });
}

// Snapshot and gain-window keys share this anchor so SSR and hydration agree on `now`.
export const floorToHour = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000;

type ConnectorCatalogEntry = { label: string; logo?: string };

/** Venue keys come from the catalog; chain keys fall through to `platformMeta`. */
export const connectorMetaForOverview = (
  accounts: readonly { id: string; connectorId: string }[],
  snapshotsNow: readonly { accountId: string; balances: BalanceView[] }[],
  catalog: Readonly<Record<string, ConnectorCatalogEntry>>,
): [string, { name: string; logo?: string }][] => {
  const keys = new Set<string>();
  const byAccount = new Map(snapshotsNow.map((s) => [s.accountId, s] as const));
  for (const account of accounts) {
    keys.add(account.connectorId);
    for (const b of byAccount.get(account.id)?.balances ?? []) {
      keys.add(b.platform ?? account.connectorId);
    }
  }
  const out: [string, { name: string; logo?: string }][] = [];
  for (const key of keys) {
    const entry = catalog[key];
    if (entry) out.push([key, { name: entry.label, logo: entry.logo }]);
  }
  return out;
};

/**
 * Shared front half of the three assembly sites (home overview, tab strip, SSR prefetch), so the
 * SSR path can't silently diverge. Fetching `platformMeta` stays per call site (hook vs fetchQuery).
 */
export function overviewConnectorInputs(
  accounts: readonly AccountSafe[],
  snapshotsNow: readonly { accountId: string; takenAt: number; balances: BalanceView[] }[],
  catalog: Readonly<Record<string, ConnectorCatalogEntry>>,
): { connectorMeta: [string, { name: string; logo?: string }][]; chainIds: string[] } {
  const connectorMeta = connectorMetaForOverview(accounts, snapshotsNow, catalog);
  const connectorLookup = (key: string) => {
    const entry = catalog[key];
    return entry ? { name: entry.label, logo: entry.logo } : null;
  };
  const byAccount: ReadonlyMap<string, SnapshotSlice> = new Map(
    snapshotsNow.map((s) => [
      s.accountId,
      { snapshot: { takenAt: s.takenAt }, balances: s.balances },
    ]),
  );
  const chainIds = overviewChainIds([...accounts], byAccount, connectorLookup);
  return { connectorMeta, chainIds };
}

export function assemblePortfolioSnapshotData(args: {
  accounts: readonly AccountSafe[];
  snapshotsNow: readonly { accountId: string; takenAt: number; balances: BalanceView[] }[];
  snapshotsPrev: readonly { accountId: string; takenAt: number; balances: BalanceView[] }[];
  enriched: ReadonlyMap<string, TokenEnrichmentView>;
  mode: ValuationMode;
  platformMeta: readonly [string, PlatformMeta][];
  connectorMeta: readonly [string, { name: string; logo?: string }][];
  fiatRefs: readonly [string, string][];
  now: number;
}): PortfolioSnapshotData {
  return {
    accounts: [...args.accounts],
    snapshots: args.snapshotsNow.map(
      (s) => [s.accountId, { takenAt: s.takenAt, balances: s.balances }] as const,
    ),
    prevSnapshots: args.snapshotsPrev.map(
      (s) => [s.accountId, { takenAt: s.takenAt, balances: s.balances }] as const,
    ),
    enriched: [...args.enriched].map(
      ([id, tv]) =>
        [
          id,
          { id: tv.id, symbol: tv.symbol, name: tv.name, price: tv.price, hasLogo: tv.hasLogo },
        ] as const,
    ),
    platformMeta: [...args.platformMeta],
    connectorMeta: [...args.connectorMeta],
    fiatRefs: [...args.fiatRefs],
    mode: args.mode,
    now: args.now,
  };
}

/**
 * `now` is the `isFirstSyncPending` clock and must be the real wall clock, separate from
 * `args.now` (the hour-floored key anchor).
 */
export function portfolioOverviewFromAtoms(
  args: Parameters<typeof assemblePortfolioSnapshotData>[0],
  now: number = Date.now(),
): OverviewView & { pending: boolean } {
  const raw = assemblePortfolioSnapshotData(args);
  return { ...overviewFromSnapshotData(raw), pending: isFirstSyncPending(raw, now) };
}

export interface AccountSnapshotEntry {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  note?: Note[];
  balances: BalanceView[];
}

const enrichBalanceRows = (
  balances: BalanceView[],
  enriched: ReadonlyMap<string, TokenEnrichmentView>,
): OverviewBalance[] =>
  balances.map((b) => {
    const id = displayTokenId(b);
    const tv = id ? enriched.get(id) : undefined;
    return tv ? { ...b, ...enrichmentFromView(tv) } : b;
  });

export function assembleAccountHoldingsData(args: {
  accounts: readonly { id: string; label: string; archivedAt: number | null }[];
  snapshotsNow: readonly AccountSnapshotEntry[];
  snapshotsPrev: readonly AccountSnapshotEntry[];
  mode: ValuationMode;
  enriched: ReadonlyMap<string, TokenEnrichmentView>;
}): AccountHoldingsData {
  const nowByAccount = new Map(args.snapshotsNow.map((s) => [s.accountId, s]));
  const rows = args.accounts.map((account) => {
    const latest = nowByAccount.get(account.id);
    const balances = enrichBalanceRows(latest?.balances ?? [], args.enriched);
    return {
      account: { id: account.id, label: account.label },
      archivedAt: account.archivedAt,
      totalUsd: latest?.totalUsd ?? 0,
      takenAt: latest?.takenAt ?? null,
      note: latest?.note,
      balances,
    };
  });
  const prevSnapshots = args.snapshotsPrev.map((s): [string, SnapshotView] => [
    s.accountId,
    { takenAt: s.takenAt, balances: s.balances },
  ]);
  return {
    rows,
    prevSnapshots,
    mode: args.mode,
  };
}

// Frozen snapshot values; live repricing and gains happen in the browser.
interface AccountHoldingRow {
  account: { id: string; label: string };
  archivedAt: number | null;
  // Archived rows use it as-is; active rows are repriced in the browser.
  totalUsd: number;
  takenAt: number | null;
  note?: Note[];
  balances: OverviewBalance[];
}

export interface AccountHoldingsData {
  rows: AccountHoldingRow[];
  prevSnapshots: [string, SnapshotView][];
  mode: ValuationMode;
}

export interface AccountHoldingsView {
  rows: WithAccountHoldingGain<AccountHoldingRow>[];
}

// Active accounts are repriced row by row (same rule as `deriveLiveAccountTotals`); archived
// accounts keep their frozen snapshot values.
export function accountRowsFromRaw(raw: AccountHoldingsData): AccountHoldingsView {
  const prevByAccount = sliceMap(raw.prevSnapshots);
  const priced = raw.rows.map((r): AccountHoldingRow => {
    if (r.archivedAt != null) return r;
    const balances = r.balances.map((b) => ({
      ...b,
      usdValue: liveValue(b, isFungible(viewKind(b)) ? b.unitPrice : undefined, raw.mode),
    }));
    return { ...r, balances, totalUsd: balances.reduce((sum, b) => sum + b.usdValue, 0) };
  });
  return { rows: attachAccountHoldingGains(priced, prevByAccount) };
}
