import type { TokenOption } from "@/lib/core/token-model";

// Local search over the prefetched catalogue (top 1000 by market cap). Input order is the
// market-cap rank, so sorts here are stable and need no rank column.

// Below this many local hits the user is likely after a long-tail token, so ask upstream.
export const LOCAL_SEARCH_ENOUGH = 8;
const SEARCH_RESULT_LIMIT = 20;

// Symbol and name prefixes share a tier on purpose: otherwise `bitc` ranks BITCI above Bitcoin.
// Within a tier, market cap decides.
function tierOf(token: TokenOption, q: string): number {
  const symbol = token.symbol.toLowerCase();
  const name = token.name.toLowerCase();
  if (symbol === q) return 0;
  if (symbol.startsWith(q) || name.startsWith(q)) return 1;
  if (symbol.includes(q) || name.includes(q)) return 2;
  return -1;
}

/** Stable within a tier, so market-cap order is kept. */
export function searchCatalogue(
  catalogue: readonly TokenOption[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): TokenOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: { token: TokenOption; tier: number }[] = [];
  for (const token of catalogue) {
    const tier = tierOf(token, q);
    if (tier >= 0) hits.push({ token, tier });
  }
  hits.sort((a, b) => a.tier - b.tier);
  return hits.slice(0, limit).map((h) => h.token);
}

export function needsRemoteSearch(localHits: readonly TokenOption[]): boolean {
  return localHits.length < LOCAL_SEARCH_ENOUGH;
}

// Browsing uses a fixed order owned → catalogue → fiat; searching sorts globally by relevance
// and then splits runs of the same kind into sections.
export type TokenSectionKey = "owned" | "fiat" | "catalogue";
export interface TokenSection {
  key: TokenSectionKey;
  items: TokenOption[];
}

// Only holdings with a ticket become options (custom symbols have no reusable identity).
// Zero-balance holdings are kept on purpose so picking one lands on the same holding.
export function buildOwnedOptions(
  holdings: readonly { ticket: string | null; symbol: string }[],
  meta: ReadonlyMap<string, { name?: string; logo?: string }>,
): TokenOption[] {
  return holdings.flatMap((h) => {
    if (!h.ticket) return [];
    const m = meta.get(h.symbol.toUpperCase());
    return [{ ticket: h.ticket, symbol: h.symbol, name: m?.name ?? h.symbol, logo: m?.logo }];
  });
}

// Kind-agnostic text-match tier (lower = better; `q` must be trimmed and lowercased). Exact
// matches beat prefixes naturally, so fiat `USD` ranks above `USDC` without a kind bonus.
function matchTier(token: TokenOption, q: string): number | null {
  const sym = token.symbol.toLowerCase();
  const name = token.name.toLowerCase();
  if (sym === q) return 0;
  if (name === q) return 1;
  if (sym.startsWith(q)) return 2;
  if (name.startsWith(q)) return 3;
  if (sym.includes(q)) return 4;
  if (name.includes(q)) return 5;
  return null;
}

// A kind can appear in several sections if sorting separates its items, so section keys repeat.
function segmentByKind(
  items: readonly { token: TokenOption; kind: TokenSectionKey }[],
): TokenSection[] {
  const out: TokenSection[] = [];
  for (const { token, kind } of items) {
    const last = out.at(-1);
    if (last?.key === kind) last.items.push(token);
    else out.push({ key: kind, items: [token] });
  }
  return out;
}

/**
 * Catalogue is pre-filtered to ~20 by `searchCatalogue` before joining the global sort.
 * No cross-source dedup: a token that is both owned and in the catalogue shows in both.
 */
export function buildTokenSections(input: {
  owned: readonly TokenOption[];
  fiat: readonly TokenOption[];
  catalogue: readonly TokenOption[];
  query: string;
  catalogueTopN: number;
  remote?: readonly TokenOption[];
}): TokenSection[] {
  const q = input.query.trim().toLowerCase();

  if (!q) {
    return segmentByKind([
      ...input.owned.map((token) => ({ token, kind: "owned" as const })),
      ...input.catalogue
        .slice(0, input.catalogueTopN)
        .map((token) => ({ token, kind: "catalogue" as const })),
      ...input.fiat.map((token) => ({ token, kind: "fiat" as const })),
    ]);
  }

  const catalogue = mergeSearchResults(searchCatalogue(input.catalogue, q), input.remote ?? []);
  const pool = [
    ...input.owned.map((token) => ({ token, kind: "owned" as const })),
    ...input.fiat.map((token) => ({ token, kind: "fiat" as const })),
    ...catalogue.map((token) => ({ token, kind: "catalogue" as const })),
  ];
  const scored: { token: TokenOption; kind: TokenSectionKey; tier: number; order: number }[] = [];
  pool.forEach((c, order) => {
    const tier = matchTier(c.token, q);
    if (tier !== null) scored.push({ token: c.token, kind: c.kind, tier, order });
  });
  // Tier, then market-cap rank (unranked last), then pool order as a stable tiebreak.
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.token.rank ?? Number.POSITIVE_INFINITY) - (b.token.rank ?? Number.POSITIVE_INFINITY) ||
      a.order - b.order,
  );
  return segmentByKind(scored);
}

// Token picking doesn't need fresh prices; an hour lets warm default prices skip most requests.
export const PRICE_STALE_MS = 60 * 60 * 1000;

export interface LivePrice {
  price: number;
  change24h?: number;
  asOf: number;
}

/**
 * `requested` fires each ticket once per open: a ticket upstream didn't price never lands in
 * `live` and would otherwise be re-requested on every re-render.
 */
export function staleTickets(
  tokens: readonly TokenOption[],
  live: ReadonlyMap<string, LivePrice>,
  requested: ReadonlySet<string>,
  now: number,
  staleMs = PRICE_STALE_MS,
): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (requested.has(t.ticket)) continue;
    const asOf = live.get(t.ticket)?.asOf ?? t.asOf;
    if (asOf == null || now - asOf > staleMs) out.push(t.ticket);
  }
  return out;
}

/** Local hits first (already ranked), deduped by ticket. */
export function mergeSearchResults(
  local: readonly TokenOption[],
  remote: readonly TokenOption[],
  limit = SEARCH_RESULT_LIMIT,
): TokenOption[] {
  const seen = new Set(local.map((t) => t.ticket));
  const out = [...local];
  for (const token of remote) {
    if (out.length >= limit) break;
    if (seen.has(token.ticket)) continue;
    seen.add(token.ticket);
    out.push(token);
  }
  return out;
}

export interface Segment {
  text: string;
  match: boolean;
}

export function matchSegments(text: string, query: string): Segment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), match: false });
    out.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return out.length > 0 ? out : [{ text, match: false }];
}
