import {
  DefiMeta,
  type DefiMeta as DefiMetaT,
  type Note,
  PerpEquityMeta,
  type PerpEquityMeta as PerpEquityMetaT,
  PerpPositionMeta,
  type PerpPositionMeta as PerpPositionMetaT,
} from "@folio/connectors-basic";
import { viewKind } from "./balance-kind";

// Splits one account's balances into display sections. The card total stays the account's
// totalUsd; this only decides how rows are grouped.

export interface OverviewBalance {
  id: string;
  // Filled in by enrichment; snapshots no longer store the symbol.
  symbol?: string;
  amount: number;
  usdValue: number;
  selfPrice?: number | null; // provider-reported unit price; null = always mark to market
  kind: string;
  // Token row id fixed at snapshot write time; null for old snapshots and manual rows.
  tokenId?: string | null;
  platform?: string | null; // chain or venue as reported by the provider; null on old rows
  metaJson: string | null;
  note?: Note; // e.g. CEX locked/frozen
  // Enrichment is cache-only; missing → undefined and the UI degrades.
  name?: string;
  logo?: string;
  unitPrice?: number;
  gain24h?: { amount: number; pct: number | null } | null;
}

export interface SpotRow {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  name?: string;
  logo?: string;
  unitPrice?: number;
  gain24h?: { amount: number; pct: number | null } | null;
  note?: Note;
}
export interface DefiRow {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  positionType?: string;
}
export interface DefiGroup {
  protocol: string;
  rows: DefiRow[];
  protocolLogo?: string; // upstream URL; rendered through the /api/logo/defi proxy
  // null = not computable (no observation 24h ago); undefined = not wired on this path.
  // `start` (value 24h ago) is kept so merged groups can recompute pct; it can't be derived from
  // pct when pct is 0 or null.
  gain24h?: { amount: number; pct: number | null; start?: number } | null;
}
export interface AccountSections {
  spot: SpotRow[];
  defi: DefiGroup[];
  perp: PerpView | null;
}

export function parseDefiMeta(metaJson: string | null): DefiMetaT {
  if (!metaJson) return {};
  try {
    const r = DefiMeta.safeParse(JSON.parse(metaJson));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

export const DEFI_FALLBACK_PROTOCOL = "Other";

// Below this |usd| a holding is noise (airdrop dust): hidden and not price-refreshed. Cost: real
// holdings under $0.10 are hidden too.
export const ZERO_DISPLAY_USD = 0.1;

export function toAccountSections(balances: OverviewBalance[]): AccountSections {
  const spot: SpotRow[] = [];
  const perpRows: OverviewBalance[] = [];
  // Insertion order = display order.
  const defiByProtocol = new Map<string, DefiRow[]>();
  const logoByProtocol = new Map<string, string>(); // first row with a logo wins

  for (const b of balances) {
    const vk = viewKind(b);
    if (vk === "perp_equity" || vk === "perp_position") {
      perpRows.push(b);
    } else if (vk === "defi") {
      const meta = parseDefiMeta(b.metaJson);
      const protocol = meta.protocol ?? DEFI_FALLBACK_PROTOCOL;
      if (meta.protocolLogo && !logoByProtocol.has(protocol)) {
        logoByProtocol.set(protocol, meta.protocolLogo);
      }
      const row: DefiRow = {
        id: b.id,
        symbol: b.symbol ?? "",
        amount: b.amount,
        usdValue: b.usdValue,
        positionType: meta.positionType,
      };
      const group = defiByProtocol.get(protocol);
      if (group) group.push(row);
      else defiByProtocol.set(protocol, [row]);
    } else {
      // Rows that would show as $0.00 are noise, not holdings.
      if (Math.abs(b.usdValue) < ZERO_DISPLAY_USD) continue;
      spot.push({
        id: b.id,
        symbol: b.symbol ?? "",
        amount: b.amount,
        usdValue: b.usdValue,
        name: b.name,
        logo: b.logo,
        unitPrice: b.unitPrice,
        gain24h: b.gain24h,
        note: b.note,
      });
    }
  }

  const defi = dropEmptyDefiGroups(
    [...defiByProtocol].map(([protocol, rows]) => ({
      protocol,
      rows,
      protocolLogo: logoByProtocol.get(protocol),
    })),
  );
  const perp = perpRows.length > 0 ? toPerpView(perpRows) : null;

  return { spot, defi, perp };
}

export function mergeDefiGroups(sections: { defi: DefiGroup[] }[]): DefiGroup[] {
  const byProtocol = new Map<string, DefiRow[]>();
  const logoByProtocol = new Map<string, string>();
  const gainByProtocol = new Map<string, { amount: number; start: number }>();
  for (const s of sections) {
    for (const g of s.defi) {
      if (g.protocolLogo && !logoByProtocol.has(g.protocol)) {
        logoByProtocol.set(g.protocol, g.protocolLogo);
      }
      const rows = byProtocol.get(g.protocol);
      if (rows) rows.push(...g.rows);
      else byProtocol.set(g.protocol, [...g.rows]);
      // Amounts add; pct is recomputed as Σamount / Σstart, not averaged.
      if (g.gain24h) {
        const prev = gainByProtocol.get(g.protocol) ?? { amount: 0, start: 0 };
        gainByProtocol.set(g.protocol, {
          amount: prev.amount + g.gain24h.amount,
          start: prev.start + (g.gain24h.start ?? 0),
        });
      }
    }
  }
  return [...byProtocol].map(([protocol, rows]) => {
    const g = gainByProtocol.get(protocol);
    return {
      protocol,
      rows,
      protocolLogo: logoByProtocol.get(protocol),
      gain24h: g
        ? { amount: g.amount, pct: g.start > 0 ? (g.amount / g.start) * 100 : null, start: g.start }
        : null,
    };
  });
}

// Gross exposure Σ|usd| (not net) so a hedged position netting to ~0 is still shown.
const DEFI_GROUP_DUST_USD = 0.005;

export function dropEmptyDefiGroups(groups: DefiGroup[]): DefiGroup[] {
  return groups.filter(
    (g) => g.rows.reduce((s, r) => s + Math.abs(r.usdValue), 0) >= DEFI_GROUP_DUST_USD,
  );
}

// Legs that don't round to $0.00, by |usd| desc. If every leg is dust, show them all: the group
// already passed the gross-exposure threshold, so dropping them would hide real value.
const DEFI_SUMMARY_DUST_USD = 0.005;

export function defiMeaningfulLegs(rows: DefiRow[]): DefiRow[] {
  const sorted = [...rows].sort((a, b) => Math.abs(b.usdValue) - Math.abs(a.usdValue));
  const meaningful = sorted.filter((r) => Math.abs(r.usdValue) >= DEFI_SUMMARY_DUST_USD);
  return meaningful.length > 0 ? meaningful : sorted;
}

// Keeps input order; legs without positionType group under role=undefined.
export function groupLegsByRole(legs: DefiRow[]): { role?: string; legs: DefiRow[] }[] {
  const order: string[] = [];
  const byRole = new Map<string, DefiRow[]>();
  for (const l of legs) {
    const key = l.positionType ?? "";
    const g = byRole.get(key);
    if (g) g.push(l);
    else {
      byRole.set(key, [l]);
      order.push(key);
    }
  }
  return order.map((key) => ({ role: key || undefined, legs: byRole.get(key) as DefiRow[] }));
}

// Rows with bad or missing meta are skipped, never thrown.

interface PerpEquityView extends PerpEquityMetaT {
  accountValue: number; // = equity row usdValue
}
export interface PerpPositionView extends PerpPositionMetaT {
  size: number; // signed: positive = long, negative = short
}
export interface PerpView {
  equity: PerpEquityView | null;
  positions: PerpPositionView[];
}

interface PerpBalance {
  amount: number;
  usdValue: number;
  kind: string;
  metaJson: string | null;
}

function parseJson(metaJson: string | null): unknown {
  if (!metaJson) return null;
  try {
    return JSON.parse(metaJson);
  } catch {
    return null;
  }
}

export function toPerpView(balances: PerpBalance[]): PerpView {
  let equity: PerpEquityView | null = null;
  const positions: PerpPositionView[] = [];

  for (const b of balances) {
    const vk = viewKind(b);
    const raw = parseJson(b.metaJson);
    if (vk === "perp_equity") {
      const r = PerpEquityMeta.safeParse(raw);
      // Multiple equity rows (e.g. Binance USD-M + COIN-M wallets) are summed, not overwritten.
      if (r.success) {
        const v = { ...r.data, accountValue: b.usdValue };
        equity = equity
          ? {
              accountValue: equity.accountValue + v.accountValue,
              withdrawable: equity.withdrawable + v.withdrawable,
              totalMarginUsed: equity.totalMarginUsed + v.totalMarginUsed,
              totalNtlPos: equity.totalNtlPos + v.totalNtlPos,
            }
          : v;
      }
    } else if (vk === "perp_position") {
      const r = PerpPositionMeta.safeParse(raw);
      if (r.success) positions.push({ ...r.data, size: b.amount });
    }
  }

  // Sort by notional (the number shown on the row), so the list reads as sorted; upstream order
  // is meaningless.
  positions.sort((a, b) => Math.abs(b.positionValue) - Math.abs(a.positionValue));

  return { equity, positions };
}

// Shared by server and client: both sides must build the same key.
export function defiGainKey(accountId: string, protocol: string): string {
  return `${accountId}|${protocol}`;
}
