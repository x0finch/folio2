import {
  DefiMeta,
  type DefiMeta as DefiMetaT,
  UtxoMeta,
  type UtxoMeta as UtxoMetaT,
} from "@folio/connectors";
import { viewKind } from "./balance-kind";
import { type PerpView, toPerpView } from "./perp";

// 纯逻辑(无 server-only import → 可单测)。把一个账户的余额行按 kind 拆成展示分区:
// 现货/UTXO → 一张表;DeFi → 按 protocol 分组;永续 → 复用 toPerpView。
// 卡片净值仍 = 账户 totalUsd(净值不变量,见 ADR 0009)。这里只管"怎么分区展示"。
// kind 走 viewKind 归一(并存期兼容遗留 kind:manual→spot、perp 靠 role、bitcoin→utxo);
// meta 用 @folio/connectors 的 zod schema safeParse(替代旧 `as` 强转)。

export interface OverviewBalance {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  kind: string;
  tokenKey?: string | null; // 快照持久化的代币寻址标识(聚合/解析用;CEX/perp/原生为空)
  metaJson: string | null;
  // 代币参考层富化(P7.4,cache-only;缺则 undefined → UI 降级)。
  name?: string;
  logo?: string;
  unitPrice?: number;
  change24h?: number;
}

export interface SpotRow {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  name?: string;
  logo?: string;
  unitPrice?: number;
  change24h?: number;
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
  utxo: UtxoMetaT | null; // BTC 未确认/分布/收款指引(无可展示则 null)
}

function parseDefiMeta(metaJson: string | null): DefiMetaT {
  if (!metaJson) return {};
  try {
    const r = DefiMeta.safeParse(JSON.parse(metaJson));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

function parseUtxoMeta(metaJson: string | null): UtxoMetaT | null {
  if (!metaJson) return null;
  try {
    const r = UtxoMeta.safeParse(JSON.parse(metaJson));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// 有内容可展示(未确认/分布/收款)才回。
function hasUtxoDetail(m: UtxoMetaT): boolean {
  return (
    m.pendingSats !== 0 ||
    Boolean(m.addresses?.length) ||
    Boolean(m.receive?.lastUsed) ||
    Boolean(m.receive?.next?.length)
  );
}

const DEFI_FALLBACK_PROTOCOL = "Other";

export function toAccountSections(balances: OverviewBalance[]): AccountSections {
  const spot: SpotRow[] = [];
  const perpRows: OverviewBalance[] = [];
  // 保序分组:首次出现的 protocol 顺序即展示顺序。
  const defiByProtocol = new Map<string, DefiRow[]>();
  let utxo: UtxoMetaT | null = null;

  for (const b of balances) {
    const vk = viewKind(b);
    if (vk === "utxo") {
      // UTXO(BTC)行:进现货表(amount+value),额外抽 meta 供明细分区。
      const m = parseUtxoMeta(b.metaJson);
      if (m && hasUtxoDetail(m)) utxo = m;
    }
    if (vk === "perp_equity" || vk === "perp_position") {
      perpRows.push(b);
    } else if (vk === "defi") {
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
      // spot / utxo:统一现货表(带上富化字段,缺则 undefined)
      spot.push({
        id: b.id,
        symbol: b.symbol,
        amount: b.amount,
        usdValue: b.usdValue,
        name: b.name,
        logo: b.logo,
        unitPrice: b.unitPrice,
        change24h: b.change24h,
      });
    }
  }

  const defi: DefiGroup[] = [...defiByProtocol].map(([protocol, rows]) => ({ protocol, rows }));
  const perp = perpRows.length > 0 ? toPerpView(perpRows) : null;

  return { spot, defi, perp, utxo };
}
