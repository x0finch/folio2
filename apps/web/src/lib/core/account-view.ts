import { DefiMeta, type DefiMeta as DefiMetaT, type Note } from "@folio/connectors-basic";
import { viewKind } from "./balance-kind";
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
  // 显示名:由 overview-model 按 token_id 从 Token 取好后填入(#243:快照不再存 symbol)。
  // 可选 —— 从快照直接读出的行还没富化,富化那步(decorate)才填上。
  symbol?: string;
  amount: number;
  usdValue: number;
  selfPrice?: number | null; // provider 自带单价(估值原料,Phase 3);读时现推的原料,null=盯市恒用源
  kind: string;
  // **归并身份**:写快照时 mint 定死的代币行 id(ADR 0021 / #201)。可空:旧快照 / 手记现造的行。
  tokenId?: string | null;
  platform?: string | null; // 这笔持仓所在的链 ∪ 场馆(provider 直接报,#193;本列之前的旧行为空)
  metaJson: string | null;
  note?: Note; // balance 级展示 note(单个 Note;CEX 该币锁仓/冻结);无则省略
  // 代币参考层富化(P7.4,cache-only;缺则 undefined → UI 降级)。
  name?: string;
  logo?: string;
  unitPrice?: number;
  change24h?: number;
  // 24h 盈亏(ADR 0040),server 读路径按快照历史 / 账本算好后附上。抽屉的现货行按它显示。
  gain24h?: { amount: number; pct: number | null } | null;
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
  gain24h?: { amount: number; pct: number | null } | null;
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
  protocolLogo?: string; // 协议 logo 上游 URL(有则行渲染经 /api/logo/defi 代理;#126)
  // 24h 盈亏(ADR 0040):由 server 读路径按快照历史算好后附上。**这一类是已知妥协** ——
  // DeFi 仓位没有「几个币」可依,只有一个总价值,所以拿两张照片的价值相减;你往里加钱那天会
  // 虚高、提出来那天会虚低。`null` = 算不出;`undefined` = 这条路没接(账户抽屉那边)。
  //
  // `grossBasis` = 百分比的分母(该协议在窗口起点的**总敞口**:各腿取绝对值再累加)。带着它是为了
  // 跨账户合并时还能算出正确的百分比 —— 净值当分母会在对冲仓上给出荒唐的数,而从 pct 反推分母
  // 在 pct 为 0 时又推不出来。
  gain24h?: { amount: number; pct: number | null; grossBasis?: number } | null;
}
export interface AccountSections {
  spot: SpotRow[];
  defi: DefiGroup[];
  perp: PerpView | null; // 无永续行 → null
}

export function parseDefiMeta(metaJson: string | null): DefiMetaT {
  if (!metaJson) return {};
  try {
    const r = DefiMeta.safeParse(JSON.parse(metaJson));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

export const DEFI_FALLBACK_PROTOCOL = "Other";

// 「尘埃」阈值(美元):持仓价值绝对值低于此即视为噪音而非持仓 —— 现货表 / 叠标**不展示**,
// 刷价/刷图那侧也**不去 CGK 刷**(见 tokens.ts `refreshableTokenIds`,#245:一条线「不展示的就不刷」)。
// 取 $0.10:几乎 $0 的空投/貔貅币成堆,砍到这条线能把数百币的钱包收敛到几十个,列表与 Top/Worst
// 也更干净(排除「$0.05 涨 900%」这类噪音)。**代价**:$0.10 以下的真实小额持仓也会被隐藏、不刷价。
export const ZERO_DISPLAY_USD = 0.1;

export function toAccountSections(balances: OverviewBalance[]): AccountSections {
  const spot: SpotRow[] = [];
  const perpRows: OverviewBalance[] = [];
  // 保序分组:首次出现的 protocol 顺序即展示顺序。
  const defiByProtocol = new Map<string, DefiRow[]>();
  const logoByProtocol = new Map<string, string>(); // protocol → logo URL(首个带图的行定)

  for (const b of balances) {
    const vk = viewKind(b);
    if (vk === "perp_equity" || vk === "perp_position") {
      perpRows.push(b);
    } else if (vk === "defi") {
      const meta = parseDefiMeta(b.metaJson);
      const protocol = meta.protocol ?? DEFI_FALLBACK_PROTOCOL;
      if (meta.protocolLogo && !logoByProtocol.has(protocol)) {
        logoByProtocol.set(protocol, meta.protocolLogo);
      }
      const row: DefiRow = {
        id: b.id,
        symbol: b.symbol ?? "",
        amount: b.amount,
        usdValue: b.usdValue,
        positionType: meta.positionType,
        change24h: b.change24h,
      };
      const group = defiByProtocol.get(protocol);
      if (group) group.push(row);
      else defiByProtocol.set(protocol, [row]);
    } else {
      // spot / utxo:统一现货表(带上富化字段 + balance 级 note,缺则 undefined)。
      // 价值显示为 $0.00 的现货(无价/空投尘埃)不展示 —— 是噪音,不是持仓。
      if (Math.abs(b.usdValue) < ZERO_DISPLAY_USD) continue;
      spot.push({
        id: b.id,
        symbol: b.symbol ?? "",
        amount: b.amount,
        usdValue: b.usdValue,
        name: b.name,
        logo: b.logo,
        unitPrice: b.unitPrice,
        change24h: b.change24h,
        gain24h: b.gain24h,
        note: b.note,
      });
    }
  }

  // 分区出口统一丢空仓组($0 毛敞口)——小计 / tab 可见性 / 抽屉 / 总览 merge 都一致,不再各处补丁。
  const defi = dropEmptyDefiGroups(
    [...defiByProtocol].map(([protocol, rows]) => ({
      protocol,
      rows,
      protocolLogo: logoByProtocol.get(protocol),
    })),
  );
  const perp = perpRows.length > 0 ? toPerpView(perpRows) : null;

  return { spot, defi, perp };
}

// —— H5 #120:总览「DEFI 头寸」独立分区(跨账户按协议合并)——

// 多账户的 defi 分组按 protocol 保序合并(组序 = 协议首见顺序,行序 = 账户遍历顺序)。
// 抽屉是单账户上下文,直接用该账户的 defi,不经此函数。
export function mergeDefiGroups(sections: { defi: DefiGroup[] }[]): DefiGroup[] {
  const byProtocol = new Map<string, DefiRow[]>();
  const logoByProtocol = new Map<string, string>(); // 跨账户:首个带图的组定 logo
  const gainByProtocol = new Map<string, { amount: number; grossBasis: number }>();
  for (const s of sections) {
    for (const g of s.defi) {
      if (g.protocolLogo && !logoByProtocol.has(g.protocol)) {
        logoByProtocol.set(g.protocol, g.protocolLogo);
      }
      const rows = byProtocol.get(g.protocol);
      if (rows) rows.push(...g.rows);
      else byProtocol.set(g.protocol, [...g.rows]);
      // 盈亏跨账户合并:金额直接相加;百分比**重算**(Σ金额 ÷ Σ总敞口),不是各账户百分比取平均。
      // 有一个账户算得出就算 —— 与「有基准的线才参与」同一个态度。
      if (g.gain24h) {
        const prev = gainByProtocol.get(g.protocol) ?? { amount: 0, grossBasis: 0 };
        gainByProtocol.set(g.protocol, {
          amount: prev.amount + g.gain24h.amount,
          grossBasis: prev.grossBasis + (g.gain24h.grossBasis ?? 0),
        });
      }
    }
  }
  return [...byProtocol].map(([protocol, rows]) => {
    const g = gainByProtocol.get(protocol);
    return {
      protocol,
      rows,
      protocolLogo: logoByProtocol.get(protocol),
      gain24h: g
        ? {
            amount: g.amount,
            pct: g.grossBasis > 0 ? (g.amount / g.grossBasis) * 100 : null,
            grossBasis: g.grossBasis,
          }
        : null,
    };
  });
}

// 空仓协议丢弃:整组毛敞口 Σ|usd| < 半分钱 → 视为已清空/dust(如已全额提取/偿还只剩 0 值残腿),
// 不进展示(否则出现「协议 $0.00」噪音行)。用毛敞口而非净值,保留净≈0 但有真实敞口的对冲仓。
// 在分区构建出口(toAccountSections)统一调用,所有消费端一致(跨账户 sub-cent 协议合并才够阈值
// 的极端情形会被逐账户滤掉,金额 <半分钱 × N,可忽略)。
const DEFI_GROUP_DUST_USD = 0.005;

export function dropEmptyDefiGroups(groups: DefiGroup[]): DefiGroup[] {
  return groups.filter(
    (g) => g.rows.reduce((s, r) => s + Math.abs(r.usdValue), 0) >= DEFI_GROUP_DUST_USD,
  );
}

// 协议有值腿(H5 评审:头寸摘要别拼出几十条 0 值空仓/奖励腿 → 噪音看不懂)。按 |美元值| 降序,
// 只留不四舍五入成 $0.00 的腿(≥ DEFI_SUMMARY_DUST_USD)。全是 dust → 全展示(组已过
// dropEmptyDefiGroups 的毛敞口阈值,这些 sub-cent 腿合起来仍有值,截 1 会漏腿)。喂构成条段与 hover 弹层。
const DEFI_SUMMARY_DUST_USD = 0.005; // < 半分钱即视为空腿

export function defiMeaningfulLegs(rows: DefiRow[]): DefiRow[] {
  const sorted = [...rows].sort((a, b) => Math.abs(b.usdValue) - Math.abs(a.usdValue));
  const meaningful = sorted.filter((r) => Math.abs(r.usdValue) >= DEFI_SUMMARY_DUST_USD);
  return meaningful.length > 0 ? meaningful : sorted;
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
