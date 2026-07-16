import { DefiMeta, type DefiMeta as DefiMetaT, type Note } from "@folio/connectors-basic";
import { viewKind } from "./balance-kind";
import { dayValueChange } from "./day-value-change";
import { type PerpView, toPerpView } from "./perp";

// 纯逻辑(无 server-only import → 可单测)。把一个账户的余额行按 kind 拆成展示分区:
// 现货/UTXO → 一张表;DeFi → 按 protocol 分组;永续 → 复用 toPerpView。
// 卡片净值仍 = 账户 totalUsd(净值不变量,见 ADR 0009)。这里只管"怎么分区展示"。
// kind 走 viewKind 归一(并存期兼容遗留 kind:manual→spot、perp 靠 role、bitcoin→utxo);
// meta 用 @folio/connectors 的 zod schema safeParse(替代旧 `as` 强转)。
// 注:balance 级展示 note(note 重设计,单个 Note)随各 balance(从 snapshot_balances.note safeParse)一路带到
// SpotRow.note —— 前端在该现货行标题右侧渲染 <NoteIndicator>。account 级 note(Note[])是每账户一份,走另一条通道
// (server row.note → AccountHoldingsCards 的 accountNote prop),不进本模块的分区。

export interface OverviewBalance {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  selfPrice?: number | null; // provider 自带单价(估值原料,Phase 3);读时现推的原料,null=盯市恒用源
  kind: string;
  tokenKey?: string | null; // 快照持久化的代币寻址标识(聚合/解析用;CEX/perp/原生为空)
  metaJson: string | null;
  note?: Note; // balance 级展示 note(单个 Note;CEX 该币锁仓/冻结);无则省略
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
  note?: Note; // balance 级展示 note(有则该行标题右侧渲染 <NoteIndicator>)
}
export interface DefiRow {
  id: string;
  symbol: string;
  amount: number;
  usdValue: number;
  positionType?: string;
  change24h?: number; // 富化字段透传(协议行 24h 聚合用;缺 → 该行不计入聚合)
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
  // 保序分组:首次出现的 protocol 顺序即展示顺序。
  const defiByProtocol = new Map<string, DefiRow[]>();

  for (const b of balances) {
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
        change24h: b.change24h,
      };
      const group = defiByProtocol.get(protocol);
      if (group) group.push(row);
      else defiByProtocol.set(protocol, [row]);
    } else {
      // spot / utxo:统一现货表(带上富化字段 + balance 级 note,缺则 undefined)
      spot.push({
        id: b.id,
        symbol: b.symbol,
        amount: b.amount,
        usdValue: b.usdValue,
        name: b.name,
        logo: b.logo,
        unitPrice: b.unitPrice,
        change24h: b.change24h,
        note: b.note,
      });
    }
  }

  const defi: DefiGroup[] = [...defiByProtocol].map(([protocol, rows]) => ({ protocol, rows }));
  const perp = perpRows.length > 0 ? toPerpView(perpRows) : null;

  return { spot, defi, perp };
}

// —— H5 #120:总览「DEFI 头寸」独立分区(跨账户按协议合并)——

// 多账户的 defi 分组按 protocol 保序合并(组序 = 协议首见顺序,行序 = 账户遍历顺序)。
// 抽屉是单账户上下文,直接用该账户的 defi,不经此函数。
export function mergeDefiGroups(sections: { defi: DefiGroup[] }[]): DefiGroup[] {
  const byProtocol = new Map<string, DefiRow[]>();
  for (const s of sections) {
    for (const g of s.defi) {
      const rows = byProtocol.get(g.protocol);
      if (rows) rows.push(...g.rows);
      else byProtocol.set(g.protocol, [...g.rows]);
    }
  }
  return [...byProtocol].map(([protocol, rows]) => ({ protocol, rows }));
}

// 协议行的 24h 增值聚合:逐行 dayValueChange(负债行负值 → 升值为负贡献,方向天然正确)。
// pct 分母 = 协议**总敞口**前值(全量行的 |前值| 之和,缺 change24h 的行按现值计):
// 用净值当分母会在 对冲仓(存≈借,净值近零)与 部分富化(分母只剩小行)时产生荒谬百分比
// (code review #3)。整协议无一行带 change24h → null(UI 只显小计,不显增量)。
export function protocolDayChange(
  rows: Pick<DefiRow, "usdValue" | "change24h">[],
): { delta: number; pct: number | null } | null {
  let delta = 0;
  let grossPrev = 0;
  let any = false;
  for (const r of rows) {
    const d = dayValueChange(r.usdValue, r.change24h);
    if (d != null) {
      any = true;
      delta += d;
    }
    grossPrev += Math.abs(r.usdValue - (d ?? 0));
  }
  if (!any) return null;
  return { delta, pct: grossPrev !== 0 ? (delta / grossPrev) * 100 : null };
}

// 协议有值腿(H5 评审:头寸摘要别拼出几十条 0 值空仓/奖励腿 → 噪音看不懂)。
// 按 |美元值| 降序,只留不四舍五入成 $0.00 的腿(≥ DEFI_SUMMARY_DUST_USD);全是 dust 则退回
// 最大 1 段(行不空)。行内摘要取前 N 段 + 折 more(defiSummary),hover 弹层用全量(本函数)。
const DEFI_SUMMARY_MAX = 3;
const DEFI_SUMMARY_DUST_USD = 0.005; // < 半分钱即视为空腿

export function defiMeaningfulLegs(rows: DefiRow[]): DefiRow[] {
  const sorted = [...rows].sort((a, b) => Math.abs(b.usdValue) - Math.abs(a.usdValue));
  const meaningful = sorted.filter((r) => Math.abs(r.usdValue) >= DEFI_SUMMARY_DUST_USD);
  return meaningful.length > 0 ? meaningful : sorted.slice(0, 1);
}

export function defiSummary(
  rows: DefiRow[],
  max: number = DEFI_SUMMARY_MAX,
): { legs: DefiRow[]; more: number } {
  const pool = defiMeaningfulLegs(rows);
  const legs = pool.slice(0, max);
  return { legs, more: pool.length - legs.length };
}

// 摘要腿按角色(positionType)分组,保持传入顺序(= defiSummary 的值降序)。
// 让副行读成「Deposit 843 GHO, 0.24 WETH · Loan −219 GHO」——每条腿对应哪个角色一目了然
// (H5 评审:同侧角色/同币腿此前分不清)。无 positionType 的腿归入 role=undefined 组。
export function groupLegsByRole(legs: DefiRow[]): { role?: string; legs: DefiRow[] }[] {
  const order: string[] = [];
  const byRole = new Map<string, DefiRow[]>();
  for (const l of legs) {
    const key = l.positionType ?? "";
    const g = byRole.get(key);
    if (g) g.push(l);
    else {
      byRole.set(key, [l]);
      order.push(key);
    }
  }
  return order.map((key) => ({ role: key || undefined, legs: byRole.get(key) as DefiRow[] }));
}
