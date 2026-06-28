import type { DefiMeta } from "@folio/core";
import { type PerpView, toPerpView } from "./perp";

// 纯逻辑(无 server-only import → 可单测)。把一个账户的余额行按 kind 拆成展示分区:
// 现货/手动 → 一张表;DeFi → 按 protocol 分组;永续 → 复用 toPerpView。
// 卡片净值仍 = 账户 totalUsd(净值不变量,见 @folio/core)。这里只管"怎么分区展示"。

export interface OverviewBalance {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  kind: string;
  source: string;
  metaJson: string | null;
}

export interface SpotRow {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
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
}
export interface AccountSections {
  spot: SpotRow[];
  defi: DefiGroup[];
  perp: PerpView | null; // 无永续行 → null
}

function parseDefiMeta(metaJson: string | null): DefiMeta {
  if (!metaJson) return {};
  try {
    const m = JSON.parse(metaJson);
    return m && typeof m === "object" ? (m as DefiMeta) : {};
  } catch {
    return {};
  }
}

const DEFI_FALLBACK_PROTOCOL = "Other";

export function toAccountSections(balances: OverviewBalance[]): AccountSections {
  const spot: SpotRow[] = [];
  const perpRows: OverviewBalance[] = [];
  // 保序分组:首次出现的 protocol 顺序即展示顺序。
  const defiByProtocol = new Map<string, DefiRow[]>();

  for (const b of balances) {
    if (b.kind === "perp") {
      perpRows.push(b);
    } else if (b.kind === "defi") {
      const meta = parseDefiMeta(b.metaJson);
      const protocol = meta.protocol ?? DEFI_FALLBACK_PROTOCOL;
      const row: DefiRow = {
        id: b.id,
        symbol: b.symbol,
        amount: b.amount,
        usdValue: b.usdValue,
        positionType: meta.positionType,
      };
      const group = defiByProtocol.get(protocol);
      if (group) group.push(row);
      else defiByProtocol.set(protocol, [row]);
    } else {
      // spot / manual:统一现货表
      spot.push({ id: b.id, symbol: b.symbol, amount: b.amount, usdValue: b.usdValue });
    }
  }

  const defi: DefiGroup[] = [...defiByProtocol].map(([protocol, rows]) => ({ protocol, rows }));
  const perp = perpRows.length > 0 ? toPerpView(perpRows) : null;

  return { spot, defi, perp };
}
