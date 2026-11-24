import type { PerpPositionView } from "@/lib/core/account-view";

// Risk/PnL derivations for perp positions, used only by the position list and LiqRing. All derived
// client-side from existing meta; division by zero or missing data returns null so the UI degrades.

// Mark price = current notional / |size|; assumes positionValue is the current notional
// (Hyperliquid semantics). A provider storing entry notional would skew this: fix it here.
export function markPx(p: PerpPositionView): number | null {
  const size = Math.abs(p.size);
  if (size === 0) return null;
  return p.positionValue / size;
}

// uPnL% relative to entry notional (|size| x entryPx), independent of leverage, as on exchanges.
export function pnlPct(p: PerpPositionView): number | null {
  const notional = Math.abs(p.size) * p.entryPx;
  if (notional === 0) return null;
  return (p.unrealizedPnl / notional) * 100;
}

// LiqRing thresholds: safety margin d = |mark - liq| / mark (direction-aware), decoupled from PnL
// and inherently leverage-aware.
const LIQ_WARN_BELOW = 0.15; // d < 15% -> warn
const LIQ_DANGER_BELOW = 0.05; // d < 5% -> danger
const LIQ_RING_FULL = 0.25; // d >= 25% -> full ring (visual fill only, not the state)

export type LiqRiskState = "safe" | "warn" | "danger";

export interface LiqRisk {
  distance: number; // fraction of the mark price to liquidation (clamped to 0 when past it)
  fill: number; // ring fill 0..1 (distance capped at LIQ_RING_FULL)
  state: LiqRiskState;
  mark: number; // mark price, carried so consumers don't re-derive it
  liquidationPx: number; // non-null liquidation price
}

// Direction-aware: positive on the safe side, negative past liquidation (clamped to 0 = danger, so
// an unsigned distance can't read a blown position as safe). The safe direction follows
// sign(entry - liq). Missing liq / entry = liq / unusable mark -> null.
export function liqRisk(p: PerpPositionView): LiqRisk | null {
  const mark = markPx(p);
  if (mark == null || mark <= 0 || p.liquidationPx == null) return null;
  const span = p.entryPx - p.liquidationPx;
  if (span === 0) return null;
  const distance = Math.max(((mark - p.liquidationPx) / mark) * Math.sign(span), 0);
  const state: LiqRiskState =
    distance < LIQ_DANGER_BELOW ? "danger" : distance < LIQ_WARN_BELOW ? "warn" : "safe";
  const fill = Math.min(distance / LIQ_RING_FULL, 1);
  return { distance, fill, state, mark, liquidationPx: p.liquidationPx };
}
