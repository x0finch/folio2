import type { PerpEquityMeta, PerpMeta, PerpPositionMeta } from "@folio/balances";

// 纯逻辑(无 server-only import → 可单测,route 保持纯展示)。
// 把一个永续账户的余额行拆成展示用视图:equity(账户净值/可提/保证金)+ positions[]。
// 余额的 metaJson(落库 JSON 字符串)在此解析并按 role 窄化到 PerpMeta(JSON 边界仅此一处)。
// 坏/缺 metaJson 的行被忽略,不抛(单账户脏数据不拖垮总览)。

export interface PerpEquityView extends PerpEquityMeta {
  accountValue: number; // = equity 行的 usdValue
}
export interface PerpPositionView extends PerpPositionMeta {
  coin: string;
  size: number; // 带符号:正=多、负=空(side 同时给出)
}
export interface PerpView {
  equity: PerpEquityView | null;
  positions: PerpPositionView[];
}

interface PerpBalance {
  symbol: string;
  amount: number;
  usdValue: number;
  metaJson: string | null;
}

function parsePerpMeta(metaJson: string | null): PerpMeta | null {
  if (!metaJson) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(metaJson);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object") return null;
  const role = (meta as { role?: unknown }).role;
  return role === "equity" || role === "position" ? (meta as PerpMeta) : null;
}

export function toPerpView(balances: PerpBalance[]): PerpView {
  let equity: PerpEquityView | null = null;
  const positions: PerpPositionView[] = [];

  for (const b of balances) {
    const meta = parsePerpMeta(b.metaJson);
    if (!meta) continue;
    if (meta.role === "equity") {
      equity = { ...meta, accountValue: b.usdValue };
    } else {
      positions.push({ ...meta, coin: b.symbol, size: b.amount });
    }
  }

  return { equity, positions };
}
