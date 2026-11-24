import type { PerpEquity, PerpPosition } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import type { ClearinghouseState } from "./api";
import { ID } from "./constants";

// Hyperliquid sends every numeric field as a string.
export type Row = PerpEquity | PerpPosition;

const MARGIN_ASSET = "USDC";

// `issued` passes the symbol through verbatim, so upper-casing is the producer's job.
const venueTokenRef = (symbol: string) => tokenRef.issued(ID, symbol.trim().toUpperCase());

const num = (s: string | null | undefined): number => Number(s ?? 0);

// Perps are leveraged exposure: using notional as value would inflate the total. The equity row
// carries value (accountValue, which includes margin and PnL); position rows are 0.
export function parseClearinghouseState(state: ClearinghouseState): Row[] {
  const out: Row[] = [];

  const ms = state.marginSummary;
  if (ms) {
    out.push({
      symbol: MARGIN_ASSET,
      amount: num(ms.accountValue),
      value: num(ms.accountValue),
      kind: "perp_equity",
      tokenRef: venueTokenRef(MARGIN_ASSET),
      meta: {
        withdrawable: num(state.withdrawable),
        totalMarginUsed: num(ms.totalMarginUsed),
        totalNtlPos: num(ms.totalNtlPos),
      },
    });
  }

  for (const ap of state.assetPositions ?? []) {
    const p = ap.position;
    if (!p?.coin) continue;
    const szi = num(p.szi);
    out.push({
      symbol: p.coin,
      amount: szi,
      value: 0,
      kind: "perp_position",
      tokenRef: venueTokenRef(p.coin),
      meta: {
        coin: p.coin,
        side: szi >= 0 ? "long" : "short",
        entryPx: num(p.entryPx),
        positionValue: num(p.positionValue),
        unrealizedPnl: num(p.unrealizedPnl),
        leverage: p.leverage?.value,
        leverageType: p.leverage?.type,
        liquidationPx: p.liquidationPx != null ? num(p.liquidationPx) : null,
        marginUsed: num(p.marginUsed),
      },
    });
  }

  return out;
}
