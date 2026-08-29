import {
  DefiMeta,
  type DefiMeta as DefiMetaT,
  type Note,
  PerpEquityMeta,
  type PerpEquityMeta as PerpEquityMetaT,
  PerpPositionMeta,
  type PerpPositionMeta as PerpPositionMetaT,
} from "@folio/connectors-basic";
import { viewKind } from "./balance-kind";

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
  // 24h 盈亏(ADR 0050:两端相减),独立读取算好、客户端贴回。抽屉的现货行按它显示。
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
  // 24h 盈亏(ADR 0050:两端相减 —— 该协议现在的净值 − 24 小时前的净值,与全站同一口径;
  // 往里加钱那天它照实计入,这是裁定的设计)。由独立盈亏读取算好、客户端贴回(attach-gains)。
  // `null` = 算不出(缺 24 小时前的观测);`undefined` = 盈亏还没贴上来。
  //
  // `basis` = 百分比的分母(该协议在起点的净值)。带着它是为了跨账户合并时还能算出正确的
  // 百分比(Σ金额 ÷ Σ起点)—— 从 pct 反推分母在 pct 为 0 时推不出来。
  gain24h?: { amount: number; pct: number | null; basis: number } | null;
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
  const gainByProtocol = new Map<string, { amount: number; basis: number }>();
  for (const s of sections) {
    for (const g of s.defi) {
      if (g.protocolLogo && !logoByProtocol.has(g.protocol)) {
        logoByProtocol.set(g.protocol, g.protocolLogo);
      }
      const rows = byProtocol.get(g.protocol);
      if (rows) rows.push(...g.rows);
      else byProtocol.set(g.protocol, [...g.rows]);
      // 盈亏跨账户合并:金额直接相加;百分比**重算**(Σ金额 ÷ Σ起点),不是各账户百分比取平均。
      // 有一个账户算得出就算 —— 与「有起点的账户才参与」同一个态度。
      if (g.gain24h) {
        const prev = gainByProtocol.get(g.protocol) ?? { amount: 0, basis: 0 };
        gainByProtocol.set(g.protocol, {
          amount: prev.amount + g.gain24h.amount,
          basis: prev.basis + g.gain24h.basis,
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
            pct: g.basis > 0 ? (g.amount / g.basis) * 100 : null,
            basis: g.basis,
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

// —— 永续:一个账户的永续行 → 分区视图(equity + positions)。
// 与上面的现货/DeFi 分区同属 toAccountSections 的产物,故同住一个文件。
// metaJson(落库 JSON)在此 safeParse 到各自 meta;坏/缺 meta 的行被忽略,不抛。

interface PerpEquityView extends PerpEquityMetaT {
  accountValue: number; // = equity 行的 usdValue
}
export interface PerpPositionView extends PerpPositionMetaT {
  // coin 由 PerpPositionMetaT 提供(#243:住 meta)。
  size: number; // 带符号:正=多、负=空(side 同时给出)
}
export interface PerpView {
  equity: PerpEquityView | null;
  positions: PerpPositionView[];
}

interface PerpBalance {
  amount: number;
  usdValue: number;
  kind: string;
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
      // 多个权益行(如 Binance 的 U 本位 + 币本位两个合约钱包)→ **累加合并**成一个账户权益视图,
      // 而非互相覆盖只留最后一个。净值本就各自计入 buildCanonicalHoldings;这里只修「权益条只显一个
      // 钱包」的展示缺陷。单权益的 provider(hyperliquid)行为不变。
      if (r.success) {
        const v = { ...r.data, accountValue: b.usdValue };
        equity = equity
          ? {
              accountValue: equity.accountValue + v.accountValue,
              withdrawable: equity.withdrawable + v.withdrawable,
              totalMarginUsed: equity.totalMarginUsed + v.totalMarginUsed,
              totalNtlPos: equity.totalNtlPos + v.totalNtlPos,
            }
          : v;
      }
    } else if (vk === "perp_position") {
      const r = PerpPositionMeta.safeParse(raw);
      // coin 从 meta 取(#243:不再依赖快照 symbol 列)。PerpPositionView 的 coin 即 meta.coin。
      if (r.success) positions.push({ ...r.data, size: b.amount });
    }
  }

  // **仓位按名义敞口降序**(#133 收尾)。以前不排 —— 于是列表是上游给的顺序,而那个顺序没有任何
  // 含义(Hyperliquid 给的就是 BTC / ETH / SOL / AVAX… 这么一串),看上去就是「乱的」。
  //
  // **为什么按名义敞口而不是占用保证金**:仓位行右侧显示的那个数**就是**名义敞口
  // (`<ValueDelta value={p.positionValue}>`)。排序键必须是屏幕上那个数,否则用户扫一眼
  // 看到的是一串没排序的金额 —— 那比不排更糟。同一条规则在别处已经成立:DeFi 的腿按显示的
  // `|usdValue|` 排、永续账户块按显示的权益排。
  // (占用保证金更能代表「押了多少钱」,但它不在这行上显示;真要按它排,得先把它显示出来。)
  //
  // 排在这里而不是各渲染点:侧边栏与主页永续 tab 是同一个 `PerpView` 的两个消费者,
  // 排一次两边就一致 —— 而账户行那排叠标用的是同一个口径(`|positionValue|`)。
  positions.sort((a, b) => Math.abs(b.positionValue) - Math.abs(a.positionValue));

  return { equity, positions };
}

// DeFi 协议盈亏在载荷里的键:账户 × 协议。服务端下发、客户端拼回同一条,两边必须同形。
export function defiGainKey(accountId: string, protocol: string): string {
  return `${accountId}|${protocol}`;
}
