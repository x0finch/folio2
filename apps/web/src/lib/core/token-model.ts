import type { BalanceRawRow } from "@folio/db";
import { type TokenRecord, tokenTicket, type UpstreamToken } from "@folio/oracle-basic";
import { ZERO_DISPLAY_USD } from "@/lib/core/account-view";
import { isFungible, viewKind } from "@/lib/core/balance-kind";
import { tokenLogoUrl, toLogoSource } from "@/lib/core/logo";
import { MANUAL_CONNECTOR_ID } from "@/lib/core/manual";

// Bridges a balance row to the token reference layer. Identity is fixed at snapshot write time
// (`token_id`); the gates below only decide whether a row participates.

export interface BalanceLike {
  kind: string;
  // null for old snapshots and synthesized manual holdings.
  tokenId?: string | null;
  platform?: string | null; // chain or venue, as reported by the provider
  usdValue?: number | null; // provider-reported; used to skip dust before refreshing
}

export interface TokenEnrichment {
  symbol?: string; // from the token row; unrecognized rows use the connector's symbol
  name?: string;
  logo?: string;
  unitPrice?: number; // USD
  marketCapRank?: number;
}

// Only fungible holdings are priced; defi/perp values come from typed meta.
export function fungibleTokenId(b: BalanceLike): string | null {
  if (!isFungible(viewKind(b))) return null;
  return b.tokenId ?? null;
}

// Display-only (name/logo). Kept apart from fungibleTokenId, which feeds valuation and would
// re-price defi rows.
export function defiTokenId(b: BalanceLike): string | null {
  if (viewKind(b) !== "defi") return null;
  return b.tokenId ?? null;
}

// Display-only, for position icons. Equity rows are collateral, not holdings, so they're excluded.
export function perpTokenId(b: BalanceLike): string | null {
  if (viewKind(b) !== "perp_position") return null;
  return b.tokenId ?? null;
}

// The one gate for enrichment, price refresh and warm-up (refreshableTokenIds filters through it).
// If they diverge, a row marked stale by enrichment never gets refreshed and its price stays old.
// Don't add per-call-site gates. Valuation doesn't use this; it uses fungibleTokenId only.
export function displayTokenId(b: BalanceLike): string | null {
  return fungibleTokenId(b) ?? defiTokenId(b) ?? perpTokenId(b);
}

// All of them, dust included: dust still needs a name and icon.
export function displayTokenIds(rows: readonly BalanceLike[]): string[] {
  return [
    ...new Set(rows.flatMap((b) => (displayTokenId(b) ? [displayTokenId(b) as string] : []))),
  ];
}

// Token ids worth refreshing from upstream: what isn't displayed isn't refreshed (saves quota and
// avoids 414s from huge id lists). Aggregates Σ|usdValue| per token, not |Σ usdValue|:
// - a hedged position (spot + defi borrow leg) nets to ~0 but both legs need the price;
// - Σ|v| is monotonic in rows, so the stale-marking side (a subset) crossing the threshold implies
//   the refresh side does too; with |Σv| a page could mark stale forever without refreshing.
// Always kept, because value can't judge them: rows without usdValue; manual holdings (0 often means
// "not priced yet"); perp positions (usdValue is always 0, notional lives in meta — without this
// they never get an icon).
export function refreshableTokenIds(
  rows: readonly BalanceLike[],
  threshold = ZERO_DISPLAY_USD,
): string[] {
  const absSum = new Map<string, number>();
  const keep = new Set<string>(); // unconditional: no usdValue / manual / perp position
  const order: string[] = [];
  for (const b of rows) {
    const id = displayTokenId(b);
    if (!id) continue;
    if (!absSum.has(id) && !keep.has(id)) order.push(id);
    if (
      b.usdValue == null ||
      b.platform === MANUAL_CONNECTOR_ID ||
      viewKind(b) === "perp_position"
    ) {
      keep.add(id);
    } else absSum.set(id, (absSum.get(id) ?? 0) + Math.abs(b.usdValue));
  }
  return order.filter((id) => keep.has(id) || (absSum.get(id) ?? 0) >= threshold);
}

// Prefer the upstream logo, falling back to the connector's own.
export function toEnrichment(e: TokenRecord): TokenEnrichment {
  return {
    symbol: e.symbol,
    name: e.name,
    logo: tokenLogoUrl(toLogoSource(e)), // proxied; never an upstream URL
    unitPrice: e.price?.unitPrice,
    marketCapRank: e.price?.marketCapRank,
  };
}

// `ticket` is opaque (base64url): the client only uses it as a React key and for equality, and
// hands it back to the server unchanged. Don't parse it client-side; that breaks when the upstream
// changes. Market data fields are optional: search results carry no price until the dropdown's
// refresh fills it.
export interface TokenOption {
  ticket: string;
  symbol: string;
  name: string;
  logo?: string;
  rank?: number;
  price?: number;
  change24h?: number;
  asOf?: number;
}

// Snapshot balances ∪ manual synthesized balances. Enrichment and price refresh must consume the
// same set (otherwise stale manual rows never get refreshed), so both go through here. Takes raw
// tuples: refresh only needs four columns, and mapping/parsing every row costs Worker CPU.
export function userDisplayBalances(
  snapshotRows: readonly BalanceRawRow[],
  manualBalances: BalanceLike[],
): BalanceLike[] {
  const out: BalanceLike[] = snapshotRows.map((r) => ({
    kind: r[4],
    usdValue: r[3],
    platform: r[6],
    tokenId: r[7],
  }));
  for (const b of manualBalances) out.push(b);
  return out;
}

// Logo is a direct upstream link, not proxied: the proxy is keyed by token row id and these tokens
// have no row yet. Acceptable: top-N market tokens are the same for everyone, so nothing leaks.
// Rank lives in `price.marketCapRank` (markets) or top-level `marketCapRank` (search).
export const toOption = (t: UpstreamToken): TokenOption => ({
  ticket: tokenTicket.encode(t.ref),
  symbol: t.symbol,
  name: t.name,
  logo: t.logo,
  rank: t.price?.marketCapRank ?? t.marketCapRank,
  price: t.price?.unitPrice,
  change24h: t.price?.change24h,
  asOf: t.price?.asOf,
});
