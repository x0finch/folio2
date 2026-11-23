import {
  PerpPositionMeta,
  type PerpPositionMeta as PerpPositionMetaT,
} from "@folio/connectors-basic";
import { buildStack, type StackEntry, type StackItem } from "@/components/avatar-stack";
import {
  DEFI_FALLBACK_PROTOCOL,
  type OverviewBalance,
  parseDefiMeta,
} from "@/lib/core/account-view";
import { viewKind } from "@/lib/core/balance-kind";
import { defiLogoUrl } from "@/lib/core/logo";

// Spot, perp positions and DeFi protocols all contribute; perp equity doesn't (it's collateral).
// Dedup by what the avatar draws: BTC spot + BTC perp share one cell, while protocols get their own
// `protocol:` namespace (Aave the protocol ≠ AAVE the coin).
// Magnitude per row: spot = signed usdValue; DeFi = |usdValue| per leg (gross exposure, so hedged
// positions still count); perp = notional from meta (its row usdValue is always 0).
export function accountStackItems(balances: OverviewBalance[]): StackItem[] {
  const entries: StackEntry[] = [];
  for (const b of balances) {
    switch (viewKind(b)) {
      case "spot": {
        const symbol = b.symbol ?? "";
        entries.push({
          k: symbol.toUpperCase(),
          name: symbol,
          logo: b.logo,
          magnitude: b.usdValue,
        });
        break;
      }
      case "perp_position": {
        // Bad/missing meta = no displayable identity; skip rather than show an empty cell.
        const meta = perpPositionMetaOf(b.metaJson);
        if (!meta) continue;
        // Use the token frozen into the snapshot; re-guessing from the symbol could disagree.
        entries.push({
          k: meta.coin.toUpperCase(),
          name: meta.coin,
          logo: b.logo,
          magnitude: Math.abs(meta.positionValue),
        });
        break;
      }
      case "defi": {
        const meta = parseDefiMeta(b.metaJson);
        const protocol = meta.protocol ?? DEFI_FALLBACK_PROTOCOL;
        // Proxied via /api/logo/defi (no third-party CDN on the client); missing → initials.
        entries.push({
          k: `protocol:${protocol}`,
          name: protocol,
          logo: defiLogoUrl(protocol, meta.protocolLogo),
          magnitude: Math.abs(b.usdValue),
        });
        break;
      }
      // perp_equity: collateral, excluded.
    }
  }
  // May be empty (never-synced account), so no `atLeastOne`.
  return buildStack(entries);
}

function parseJson(metaJson: string | null): unknown {
  if (!metaJson) return null;
  try {
    return JSON.parse(metaJson);
  } catch {
    return null;
  }
}

// The notional lives only in meta: a perp row's usdValue is always 0 (equity carries net worth),
// so sorting/filtering by it would drop every position as dust.
function perpPositionMetaOf(metaJson: string | null): PerpPositionMetaT | undefined {
  const r = PerpPositionMeta.safeParse(parseJson(metaJson));
  return r.success ? r.data : undefined;
}
