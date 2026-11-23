import type { Note, Spot } from "@folio/connectors-basic";
import type {
  OkxDetail,
  OkxFundingAsset,
  OkxPositionsResponse,
  OkxSavingsRow,
  OkxStakingOrder,
  OkxValuationResponse,
} from "@folio/okx-client";
import { tokenRef } from "@folio/oracle-ref";
import { formatAmount, formatWhole } from "../note-format";
import { EARN_RESIDUAL_MIN_USD, OKX_EARN_LOGO, PROVIDER_ID, STABLECOINS } from "./constants";

// amount = cashBal, not eq: for coins used as futures margin, eq includes unrealized PnL.
// price = eqUsd / eq (market price, independent of PnL). Frozen coins get a "Frozen" note.
const fmtAmount = formatAmount;

export function parseBalances(details: OkxDetail[]): Spot[] {
  const out: Spot[] = [];
  for (const d of details ?? []) {
    const ccy = d.ccy;
    if (!ccy) continue;
    const amount = Number(d.cashBal ?? 0);
    if (!(amount > 0)) continue;
    const eq = Number(d.eq ?? 0);
    // No quote → undefined, not 0: a 0 self-price is treated as valid and pins the coin at $0.
    const usd = Number(d.eqUsd ?? 0);
    const price = eq > 0 && usd > 0 ? usd / eq : undefined;
    const frozen = Number(d.frozenBal ?? 0);
    const row: Spot = {
      symbol: ccy,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
    };
    if (frozen > 0) {
      const pct = amount > 0 ? Math.round((frozen / amount) * 100) : 0;
      row.note = {
        title: "Frozen",
        icon: "warning",
        content: `${fmtAmount(frozen)} ${ccy} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

// Funding and earn endpoints have no USD prices; reuse the trading account's implied prices (no
// extra request). Coins not found there (and not stablecoins) stay at value 0 for the oracle.
export type PriceHint = Record<string, number>;
export function buildPriceHint(details: OkxDetail[]): PriceHint {
  const hint: PriceHint = {};
  for (const d of details ?? []) {
    if (!d.ccy) continue;
    const eq = Number(d.eq ?? 0);
    const px = eq > 0 ? Number(d.eqUsd ?? 0) / eq : 0;
    if (px > 0) hint[d.ccy.trim().toUpperCase()] = px;
  }
  return hint;
}
function priceOf(symbol: string, hint: PriceHint): number | undefined {
  const s = symbol.trim().toUpperCase();
  if (STABLECOINS.has(s)) return 1;
  return hint[s];
}

// amount = `bal` (includes frozen).
export function parseFunding(assets: OkxFundingAsset[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const a of assets ?? []) {
    const ccy = a.ccy;
    if (!ccy) continue;
    const amount = Number(a.bal ?? 0);
    if (!(amount > 0)) continue;
    const price = priceOf(ccy, hint);
    out.push({
      symbol: ccy,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
      note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
    });
  }
  return out;
}

// Decimal → percent ("0.03" → "3.00%").
const apyPct = (rate: string | number | undefined): string =>
  `${(Number(rate ?? 0) * 100).toFixed(2)}%`;

function earnRow(ccy: string, amount: number, content: string, hint: PriceHint): Spot {
  const price = priceOf(ccy, hint);
  return {
    symbol: ccy,
    amount,
    price,
    value: price != null ? amount * price : 0,
    kind: "spot",
    tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
    note: { title: "Earn", icon: "info", content, group: "earn" },
  };
}

export function parseSavings(rows: OkxSavingsRow[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const r of rows ?? []) {
    const ccy = r.ccy;
    const amount = Number(r.amt ?? 0);
    if (!ccy || !(amount > 0)) continue;
    out.push(earnRow(ccy, amount, `Flexible · ${apyPct(r.rate)} APY`, hint));
  }
  return out;
}

// On-chain earn coins sit in the protocol, not the trading account, so there's no double count
// (liquid staking tokens like OKSOL show up under trading instead).
export function parseStaking(orders: OkxStakingOrder[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const o of orders ?? []) {
    const label = o.protocol?.trim() || "Staking";
    for (const inv of o.investData ?? []) {
      const ccy = inv.ccy ?? o.ccy;
      const amount = Number(inv.amt ?? 0);
      if (!ccy || !(amount > 0)) continue;
      out.push(earnRow(ccy, amount, `${label} · ${apyPct(o.apy)} APY`, hint));
    }
  }
  return out;
}

const fmtUsd = (n: number): string => `$${formatWhole(Math.round(n))}`;

// The earn bucket's authoritative USD minus itemised earn = fixed-term / structured principal with
// no per-coin breakdown. Emitted as one opaque `custom:` row (kept out of real-coin merges) so it
// counts toward net worth — but only when trustworthy: no unpriced earn items and above threshold.
export function earnResidualRow(
  earnBucketUsd: number,
  earnItems: Spot[],
  hint: PriceHint,
): Spot | undefined {
  let valued = 0;
  let unpriced = 0;
  for (const item of earnItems) {
    if (priceOf(item.symbol, hint) != null) valued += item.value;
    else unpriced++;
  }
  if (unpriced > 0) return undefined;
  const residual = earnBucketUsd - valued;
  if (!(residual > EARN_RESIDUAL_MIN_USD)) return undefined;
  return {
    // No per-coin composition: amount is the USD value itself (price 1).
    symbol: "USD",
    name: "OKX Earn (Uncategorized)",
    logo: OKX_EARN_LOGO,
    amount: residual,
    price: 1,
    value: residual,
    selfPrice: 1,
    kind: "spot",
    tokenRef: tokenRef.custom(PROVIDER_ID, "EARN-UNCATEGORIZED"),
    note: {
      title: "Earn (Uncategorized)",
      icon: "info",
      content: `${fmtUsd(residual)} of fixed-term / structured earn — value from OKX, no per-coin breakdown available`,
      group: "earn",
    },
  };
}

// Classic accounts aren't fetched, so a non-zero classic bucket means unsynced funds. No such check
// for trading/funding: their USD values legitimately differ and would raise false alarms.
export function classicNote(valuation: OkxValuationResponse): Note | undefined {
  const classicBucket = Number(valuation.data?.[0]?.details?.classic ?? 0);
  if (!(classicBucket > EARN_RESIDUAL_MIN_USD)) return undefined;
  return {
    title: "Classic account not synced",
    icon: "warning",
    content: `About ${fmtUsd(classicBucket)} sits in your OKX Classic account, which Folio doesn't sync`,
  };
}

// Perps aren't parsed yet. Only non-zero `pos` counts: /positions may return closed rows.
export function perpNote(positions: OkxPositionsResponse): Note | undefined {
  const hasOpen = (positions.data ?? []).some((p) => Number(p.pos ?? 0) !== 0);
  return hasOpen ? perpFallbackNote() : undefined;
}

function perpFallbackNote(): Note {
  return {
    title: "Futures positions detected",
    icon: "warning",
    content: "Futures uPnL isn't included yet — coming when the perp path ships",
  };
}

// Only reached for permanent failures (transient ones already failed the account).
export function bucketFailureNote(failed: { name: string; auth: boolean }[]): Note {
  const names = failed.map((f) => f.name).join(" / ");
  const anyAuth = failed.some((f) => f.auth);
  const tail = anyAuth ? "check the API key's permissions" : "couldn't be read this round";
  return { title: "Buckets not synced", icon: "warning", content: `${names} — ${tail}` };
}
