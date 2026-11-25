import type { Note, PerpEquity, PerpPosition, Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { formatAmount } from "../../runtime/note-format";
import type {
  CoinmAccount,
  EarnFlexibleRow,
  EarnLockedRow,
  FundingAsset,
  FuturesAccount,
  SpotAccount,
} from "./api";
import { ID, MARGIN_ASSET, QUOTE_ASSET, QUOTE_SUFFIXES, STABLECOINS } from "./constants";

export type BinanceRow = Spot | PerpEquity | PerpPosition;

// Binance balances carry quantities only, no USD: value from public tickers as `${asset}USDT`.

// amount = free + locked. A coin with locked > 0 gets a "Locked" note in its own units.
export function parseAccountBalances(account: SpotAccount, prices: Record<string, number>): Spot[] {
  const out: Spot[] = [];
  for (const b of account.balances ?? []) {
    const asset = b.asset;
    if (!asset) continue;
    // Spot also returns Flexible Earn shares as `LD<coin>`; the earn wallet fetches those, so skip
    // them to avoid double counting. Length > 3 keeps real coins like LDO.
    if (asset.startsWith("LD") && asset.length > 3) continue;
    const locked = Number(b.locked ?? 0);
    const amount = Number(b.free ?? 0) + locked;
    if (!(amount > 0)) continue;
    const price = STABLECOINS.has(asset) ? 1 : (prices[`${asset}${QUOTE_ASSET}`] ?? undefined);
    const usdValue = price != null ? amount * price : 0;
    const row: Spot = {
      symbol: asset,
      amount,
      price,
      value: usdValue,
      kind: "spot",
      tokenRef: tokenRef.issued(ID, asset.trim().toUpperCase()),
    };
    if (locked > 0) {
      const pct = amount > 0 ? Math.round((locked / amount) * 100) : 0;
      row.note = {
        title: "Locked",
        icon: "warning",
        content: `${formatAmount(locked)} ${asset} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

function coinFromSymbol(symbol: string): string {
  for (const q of QUOTE_SUFFIXES) {
    if (symbol.endsWith(q) && symbol.length > q.length) return symbol.slice(0, -q.length);
  }
  return symbol;
}

// One valued equity row plus value-0 position rows. An empty account yields nothing. The account
// response has no liquidation price, so it's null.
export function parseFuturesAccount(account: FuturesAccount): (PerpEquity | PerpPosition)[] {
  const positions = (account.positions ?? []).filter((p) => Number(p.positionAmt ?? 0) !== 0);
  const equity = Number(account.totalMarginBalance ?? 0);
  if (!(equity > 0) && positions.length === 0) return [];

  const out: (PerpEquity | PerpPosition)[] = [];
  out.push({
    symbol: MARGIN_ASSET,
    amount: equity,
    value: equity,
    kind: "perp_equity",
    tokenRef: tokenRef.issued(ID, MARGIN_ASSET),
    meta: {
      withdrawable: Number(account.maxWithdrawAmount ?? 0),
      totalMarginUsed: Number(account.totalPositionInitialMargin ?? 0),
      totalNtlPos: positions.reduce((s, p) => s + Math.abs(Number(p.notional ?? 0)), 0),
    },
  });

  for (const p of positions) {
    const symbol = p.symbol;
    if (!symbol) continue;
    const amt = Number(p.positionAmt ?? 0);
    const coin = coinFromSymbol(symbol);
    out.push({
      symbol: coin,
      amount: amt,
      value: 0,
      kind: "perp_position",
      tokenRef: tokenRef.issued(ID, coin),
      meta: {
        coin,
        side: amt >= 0 ? "long" : "short",
        entryPx: Number(p.entryPrice ?? 0),
        positionValue: Math.abs(Number(p.notional ?? 0)),
        unrealizedPnl: Number(p.unrealizedProfit ?? 0),
        leverage: p.leverage != null ? Number(p.leverage) : undefined,
        leverageType: p.isolated ? "isolated" : "cross",
        liquidationPx: null,
        marginUsed: Number(p.positionInitialMargin ?? 0),
      },
    });
  }
  return out;
}

// BTCUSD_PERP / BTCUSD_251226 → BTC
function coinmCoin(symbol: string): string {
  const base = symbol.split("_")[0];
  return base.endsWith("USD") && base.length > 3 ? base.slice(0, -3) : base;
}

// COIN-M has no single USD equity: each coin's figures are converted at market and summed into one
// equity row. A coin with no price counts as 0 for now. Position amount is in contracts.
export function parseCoinmFuturesAccount(
  account: CoinmAccount,
  prices: Record<string, number>,
): (PerpEquity | PerpPosition)[] {
  const priceOf = (coin: string) =>
    STABLECOINS.has(coin) ? 1 : (prices[`${coin}${QUOTE_ASSET}`] ?? 0);

  let equityUsd = 0;
  let withdrawableUsd = 0;
  let marginUsedUsd = 0;
  for (const a of account.assets ?? []) {
    if (!a.asset) continue;
    const px = priceOf(a.asset);
    equityUsd += Number(a.marginBalance ?? 0) * px;
    withdrawableUsd += Number(a.maxWithdrawAmount ?? 0) * px;
    marginUsedUsd += Number(a.positionInitialMargin ?? 0) * px;
  }

  const positions = (account.positions ?? []).filter((p) => Number(p.positionAmt ?? 0) !== 0);
  if (!(equityUsd > 0) && positions.length === 0) return [];

  const posRows: PerpPosition[] = [];
  let totalNtlPos = 0;
  for (const p of positions) {
    if (!p.symbol) continue;
    const coin = coinmCoin(p.symbol);
    const px = priceOf(coin);
    const notionalUsd = Math.abs(Number(p.notional ?? 0)) * px;
    totalNtlPos += notionalUsd;
    const amt = Number(p.positionAmt ?? 0);
    posRows.push({
      symbol: coin,
      amount: amt,
      value: 0,
      kind: "perp_position",
      tokenRef: tokenRef.issued(ID, coin),
      meta: {
        coin,
        side: amt >= 0 ? "long" : "short",
        entryPx: Number(p.entryPrice ?? 0),
        positionValue: notionalUsd,
        unrealizedPnl: Number(p.unrealizedProfit ?? 0) * px,
        leverage: p.leverage != null ? Number(p.leverage) : undefined,
        leverageType: p.isolated ? "isolated" : "cross",
        liquidationPx: null,
        marginUsed: Number(p.positionInitialMargin ?? 0) * px,
      },
    });
  }

  return [
    {
      symbol: MARGIN_ASSET,
      amount: equityUsd,
      value: equityUsd,
      kind: "perp_equity",
      tokenRef: tokenRef.issued(ID, MARGIN_ASSET),
      meta: { withdrawable: withdrawableUsd, totalMarginUsed: marginUsedUsd, totalNtlPos },
    },
    ...posRows,
  ];
}

export function parseFundingAssets(
  assets: readonly FundingAsset[],
  prices: Record<string, number>,
): Spot[] {
  const out: Spot[] = [];
  for (const a of assets ?? []) {
    const asset = a.asset;
    if (!asset) continue;
    const amount =
      Number(a.free ?? 0) +
      Number(a.locked ?? 0) +
      Number(a.freeze ?? 0) +
      Number(a.withdrawing ?? 0);
    if (!(amount > 0)) continue;
    const price = STABLECOINS.has(asset) ? 1 : (prices[`${asset}${QUOTE_ASSET}`] ?? undefined);
    out.push({
      symbol: asset,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(ID, asset.trim().toUpperCase()),
      note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
    });
  }
  return out;
}

interface EarnFlexible {
  readonly rows?: readonly EarnFlexibleRow[];
}
interface EarnLocked {
  readonly rows?: readonly EarnLockedRow[];
}

const apyPct = (rate: string | number | undefined): string =>
  `${(Number(rate ?? 0) * 100).toFixed(2)}%`;
// UTC, so the date doesn't shift with the timezone.
function mmdd(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

// The same coin in flexible and locked becomes two rows; aggregation merges them downstream.
export function parseEarnPositions(
  flexible: EarnFlexible,
  locked: EarnLocked,
  prices: Record<string, number>,
): Spot[] {
  const out: Spot[] = [];
  const add = (asset: string | undefined, amount: number, note: Note) => {
    if (!asset || !(amount > 0)) return;
    const price = STABLECOINS.has(asset) ? 1 : (prices[`${asset}${QUOTE_ASSET}`] ?? undefined);
    out.push({
      symbol: asset,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(ID, asset.trim().toUpperCase()),
      note,
    });
  };
  for (const r of flexible.rows ?? []) {
    add(r.asset, Number(r.totalAmount ?? 0), {
      title: "Earn",
      icon: "info",
      content: `Flexible · ${apyPct(r.latestAnnualPercentageRate)} APY`,
      group: "earn",
    });
  }
  for (const r of locked.rows ?? []) {
    const dd = r.redeemDate != null ? mmdd(Number(r.redeemDate)) : "";
    add(r.asset, Number(r.amount ?? 0), {
      title: "Earn",
      icon: "info",
      content: `Locked${dd ? ` until ${dd}` : ""} · ${apyPct(r.apy)} APY`,
      group: "earn",
    });
  }
  return out;
}
