import type { BybitCoin, BybitEarnPosition, BybitFundingCoin } from "@folio/bybit-client";
import type { Note, Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { formatAmount, formatCents } from "../note-format";
import { PROVIDER_ID, STABLECOINS } from "./constants";

// amount = walletBalance (cash), not equity, which includes futures uPnL. value = Bybit's own
// usdValue. Locked coins get a "Locked" note but still count as held.
const fmtAmount = formatAmount;

export function parseUnified(coins: BybitCoin[]): Spot[] {
  const out: Spot[] = [];
  for (const c of coins ?? []) {
    const coin = c.coin;
    if (!coin) continue;
    const amount = Number(c.walletBalance ?? 0);
    if (!(amount > 0)) continue;
    const usdValue = Number(c.usdValue ?? 0);
    const row: Spot = {
      symbol: coin,
      amount,
      // usdValue 0 (unpriced coin) → no price, value 0; the oracle fills it in.
      price: usdValue > 0 ? usdValue / amount : undefined,
      value: usdValue,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, coin.trim().toUpperCase()),
    };
    const locked = Number(c.locked ?? 0);
    if (locked > 0) {
      const pct = amount > 0 ? Math.round((locked / amount) * 100) : 0;
      row.note = {
        title: "Locked",
        icon: "warning",
        content: `${fmtAmount(locked)} ${coin} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

// The funding endpoint has no USD prices; reuse the unified account's implied prices (no extra
// request). Coins not found there (and not stablecoins) stay at value 0 for the oracle.
export type PriceHint = Record<string, number>;
export function buildPriceHint(coins: BybitCoin[]): PriceHint {
  const hint: PriceHint = {};
  for (const c of coins ?? []) {
    if (!c.coin) continue;
    const amount = Number(c.walletBalance ?? 0);
    const usd = Number(c.usdValue ?? 0);
    if (amount > 0 && usd > 0) hint[c.coin.trim().toUpperCase()] = usd / amount;
  }
  return hint;
}
function priceOf(symbol: string, hint: PriceHint): number | undefined {
  const s = symbol.trim().toUpperCase();
  if (STABLECOINS.has(s)) return 1;
  return hint[s];
}

export function parseFunding(assets: BybitFundingCoin[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const a of assets ?? []) {
    const coin = a.coin;
    if (!coin) continue;
    const amount = Number(a.walletBalance ?? 0);
    if (!(amount > 0)) continue;
    const price = priceOf(coin, hint);
    out.push({
      symbol: coin,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, coin.trim().toUpperCase()),
      note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
    });
  }
  return out;
}

// No APY: Bybit's position endpoint has no APR field. Skips redeemed positions (amount ≤ 0).
export function parseEarn(positions: BybitEarnPosition[], label: string, hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const p of positions ?? []) {
    const coin = p.coin;
    if (!coin) continue;
    const amount = Number(p.amount ?? 0);
    if (!(amount > 0)) continue;
    const price = priceOf(coin, hint);
    out.push({
      symbol: coin,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, coin.trim().toUpperCase()),
      note: { title: "Earn", icon: "info", content: label, group: "earn" },
    });
  }
  return out;
}

const fmtSignedUsd = (n: number): string => `${n < 0 ? "-" : "+"}$${formatCents(Math.abs(n))}`;

// Only reached for permanent failures (transient ones already failed the account).
export function bucketFailureNote(failed: { name: string; auth: boolean }[]): Note {
  const names = failed.map((f) => f.name).join(" / ");
  const tail = failed.some((f) => f.auth)
    ? "check the API key's permissions"
    : "couldn't be read this round";
  return { title: "Buckets not synced", icon: "warning", content: `${names} — ${tail}` };
}

// Perps aren't parsed yet; a non-zero totalPerpUPL (in the unified response, no extra request) is
// exactly the uPnL hidden from walletBalance.
export function perpFallbackNote(uplUsd: number): Note {
  return {
    title: "Futures positions detected",
    icon: "warning",
    content: `Futures uPnL (${fmtSignedUsd(uplUsd)}) isn't in your balance yet — coming when the perp path ships`,
  };
}
