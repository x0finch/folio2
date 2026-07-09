import {
  PerpEquityMeta,
  type PerpEquityMeta as PerpEquityMetaT,
  PerpPositionMeta,
  type PerpPositionMeta as PerpPositionMetaT,
} from "@folio/connectors-basic";
import { viewKind } from "./balance-kind";

// 纯逻辑(无 server-only import → 可单测,route 保持纯展示)。
// 把一个永续账户的余额行拆成展示用视图:equity(账户净值/可提/保证金)+ positions[]。
// kind 走 viewKind 归一:并存期同时吃新 perp_equity/perp_position(kind 即判别)与遗留 perp(靠 meta.role)。
// metaJson(落库 JSON)在此 safeParse 到各自 meta(JSON 边界仅此一处;遗留的多余 role 键被 zod strip)。
// 坏/缺 metaJson 的行被忽略,不抛(单账户脏数据不拖垮总览)。

export interface PerpEquityView extends PerpEquityMetaT {
  accountValue: number; // = equity 行的 usdValue
}
export interface PerpPositionView extends PerpPositionMetaT {
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
  kind: string;
  tokenKey?: string | null;
  metaJson: string | null;
}

function parseJson(metaJson: string | null): unknown {
  if (!metaJson) return null;
  try {
    return JSON.parse(metaJson);
  } catch {
    return null;
  }
}

export function toPerpView(balances: PerpBalance[]): PerpView {
  let equity: PerpEquityView | null = null;
  const positions: PerpPositionView[] = [];

  for (const b of balances) {
    const vk = viewKind(b);
    const raw = parseJson(b.metaJson);
    if (vk === "perp_equity") {
      const r = PerpEquityMeta.safeParse(raw);
      if (r.success) equity = { ...r.data, accountValue: b.usdValue };
    } else if (vk === "perp_position") {
      const r = PerpPositionMeta.safeParse(raw);
      if (r.success) positions.push({ ...r.data, coin: b.symbol, size: b.amount });
    }
  }

  return { equity, positions };
}
