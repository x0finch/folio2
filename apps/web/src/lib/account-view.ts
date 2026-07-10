import { DefiMeta, type DefiMeta as DefiMetaT } from "@folio/connectors-basic";
import { DetailBlock } from "@folio/detail-block-basic";
import { viewKind } from "./balance-kind";
import { type PerpView, toPerpView } from "./perp";

// 纯逻辑(无 server-only import → 可单测)。把一个账户的余额行按 kind 拆成展示分区:
// 现货(含并回 spot 的 BTC)→ 一张表;DeFi → 按 protocol 分组;永续 → 复用 toPerpView。
// 卡片净值仍 = 账户 totalUsd(净值不变量,见 ADR 0009)。这里只管"怎么分区展示"。
// kind 走 viewKind 归一(并存期兼容遗留 kind:manual/utxo/bitcoin → spot、perp 靠 role);
// BTC 展示细节(未确认/派生地址/收款)改由 detail 块承载(ADR 0010),不再从 meta 抽 utxo 分区。
// meta 用 @folio/connectors 的 zod schema safeParse(替代旧 `as` 强转)。

export interface OverviewBalance {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  kind: string;
  tokenKey?: string | null; // 快照持久化的代币寻址标识(聚合/解析用;CEX/perp/原生为空)
  metaJson: string | null;
  // detail:provider 专属仅供展示的结构化块的落库 JSON(ADR 0010,detail_json 列)。读端 safeParse
  // 成 DetailBlock[](与 metaJson 同套路),交前端 <BalanceDetail> 渲染;坏/缺 → 视作无块。
  detailJson?: string | null;
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
  detail: DetailBlock[]; // provider 专属展示块(含 BTC 未确认/派生地址/收款,ADR 0010);无块则空
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

// detail_json → DetailBlock[](ADR 0010)。逐块 safeParse —— 坏 JSON → 空;未知/畸形的【单块】跳过,
// 其余保留(前向兼容:未来新块类型不拖垮同批已知块)。<BalanceDetail> 再对未知 type / 缺字段做二次跳过。
function parseDetail(detailJson: string | null | undefined): DetailBlock[] {
  if (!detailJson) return [];
  try {
    const raw = JSON.parse(detailJson);
    if (!Array.isArray(raw)) return [];
    const blocks: DetailBlock[] = [];
    for (const item of raw) {
      const r = DetailBlock.safeParse(item);
      if (r.success) blocks.push(r.data);
    }
    return blocks;
  } catch {
    return [];
  }
}

const DEFI_FALLBACK_PROTOCOL = "Other";

export function toAccountSections(balances: OverviewBalance[]): AccountSections {
  const spot: SpotRow[] = [];
  const perpRows: OverviewBalance[] = [];
  // 保序分组:首次出现的 protocol 顺序即展示顺序。
  const defiByProtocol = new Map<string, DefiRow[]>();
  const detail: DetailBlock[] = [];

  for (const b of balances) {
    const blocks = parseDetail(b.detailJson);
    if (blocks.length > 0) detail.push(...blocks);
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
      // spot(含并回 spot 的 BTC 及遗留 utxo/manual):统一现货表(带上富化字段,缺则 undefined)
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

  return { spot, defi, perp, detail };
}
