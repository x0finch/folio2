import { DefiMeta, type DefiMeta as DefiMetaT } from "@folio/connectors-basic";
import { viewKind } from "./balance-kind";
import { type PerpView, toPerpView } from "./perp";

// 纯逻辑(无 server-only import → 可单测)。把一个账户的余额行按 kind 拆成展示分区:
// 现货(含 BTC)→ 一张表;DeFi → 按 protocol 分组;永续 → 复用 toPerpView。
// 卡片净值仍 = 账户 totalUsd(净值不变量,见 ADR 0009)。这里只管"怎么分区展示"。
// kind 走 viewKind 归一(并存期兼容遗留 kind:manual→spot、perp 靠 role、旧 utxo→spot);
// meta 用 @folio/connectors 的 zod schema safeParse(替代旧 `as` 强转)。
// detail:provider 拼的 markdown 展示细节(BTC 未确认/派生、CEX 锁仓列表)。改为【账户级聚合】——
// 把该账户所有 balance 的非空 detail 按 balance 顺序用 \n 连成一个 accountDetail,顶部单手风琴渲染
// (见 holdings-cards),不再挂到 per-holding 行。

export interface OverviewBalance {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  kind: string;
  tokenKey?: string | null; // 快照持久化的代币寻址标识(聚合/解析用;CEX/perp/原生为空)
  metaJson: string | null;
  detail?: string | null; // provider 拼的 markdown 展示细节(快照持久化;缺则 undefined)
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
  accountDetail: string | null; // 该账户所有 balance 非空 detail 按序 \n 连接;全空 → null
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

const DEFI_FALLBACK_PROTOCOL = "Other";

export function toAccountSections(balances: OverviewBalance[]): AccountSections {
  const spot: SpotRow[] = [];
  const perpRows: OverviewBalance[] = [];
  // 账户级 detail 聚合:按 balance 顺序收集非空 detail,最后 \n 连接成一个 accountDetail。
  const detailParts: string[] = [];
  // 保序分组:首次出现的 protocol 顺序即展示顺序。
  const defiByProtocol = new Map<string, DefiRow[]>();

  for (const b of balances) {
    if (b.detail) detailParts.push(b.detail);
    const vk = viewKind(b);
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
      // spot(含并入的 BTC):统一现货表(带上富化字段;detail 已上移到账户级聚合)
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
  const accountDetail = detailParts.length > 0 ? detailParts.join("\n") : null;

  return { spot, defi, perp, accountDetail };
}
