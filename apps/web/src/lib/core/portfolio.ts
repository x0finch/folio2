import type { AccountSafe, SnapshotWithBalances } from "@folio/db";
import {
  fiatCodeOf,
  type PlatformMeta,
  type TokenRecord,
  type ValuationMode,
  valuate,
} from "@folio/oracle-basic";
import {
  DEFI_FALLBACK_PROTOCOL,
  type DefiGroup,
  defiGainKey,
  mergeDefiGroups,
  type OverviewBalance,
  parseDefiMeta,
  toAccountSections,
} from "@/lib/core/account-view";
import { isFungible, viewKind } from "@/lib/core/balance-kind";
import {
  buildPortfolioHistory,
  type HistoryPoint,
  type SnapshotTotalRow,
} from "@/lib/core/history";
import { platformLogoUrl, tokenLogoUrl } from "@/lib/core/logo";

// 首页 / 组合的**纯计算层**(FOL-45)。跟 `history.ts` 同目录、同风格:无 Effect、无 Oracle、
// 无 cloudflare env —— 喂原料(账户 / 快照 / 富化字典 / 价格字典 / 平台元数据字典)→ 出视图形状。
// 口径只在这一处定义,读接口、同步收官、后台补算都调这里。
//
// 「怎么取原料」(读 Oracle 富化、读 D1 历史)是**调用点的薄适配层**的事(`portfolio/scope.ts`
// 的 `buildScopedOverview`、`portfolio/account-holdings.ts` 等):它们在 Effect 里备好字典,再把
// 这些纯函数当普通函数调。这样这一层既能脱离 server fn 单测,也能在同步收官那一刻被直接算。

const balancesOf = (byAccount: Map<string, SnapshotWithBalances>, id: string): OverviewBalance[] =>
  (byAccount.get(id)?.balances ?? []) as OverviewBalance[];

//  —— 现价(读时现推)

// 读时现推(Phase 3,#81):不落库,按当前 mode + 实时源价重算 value。
// 关键:存储的 `selfPrice` 已编码盯市决策 —— null = 盯市类型(manual/bitcoin,无权威自带价,恒用源);
// 数值 = enrich-not-reprice(CEX/链上/perp,自带价 = 同步时 value/amount)。故读时无需 connectorId,
// 纯 valuate(amount, selfPrice, 源价, mode)。源价缺(未解析/未预热)或都无 → 兜底冻结 usdValue。
export interface RevaluableBalance {
  amount: number;
  usdValue: number;
  selfPrice?: number | null;
}

export function liveValue(
  b: RevaluableBalance,
  sourcePrice: number | undefined,
  mode: ValuationMode,
): number {
  const v = valuate(b.amount, b.selfPrice ?? undefined, sourcePrice, mode);
  return v?.value ?? b.usdValue;
}

// 只对同质持仓取价:现货 + UTXO(BTC);defi/perp 不取(价值/展示走 typed meta)。
// (与 `tokens/model.ts` 的 `fungibleTokenId` 同口径 —— 这里内联,免得纯核心反过来依赖 server 层。)
const fungibleId = (b: OverviewBalance): string | null =>
  isFungible(viewKind(b)) ? (b.tokenId ?? null) : null;

// 按账户现推净值:对每账户最新快照的**全部**余额取 cache-only 源价(富化字典按 token_id 查),liveValue 求和。
// self-first(默认)下 enrich-not-reprice 行 value≡冻结、盯市行取实时源价 → 与主页总价同源同算。
// 主页(buildOverview)与资产曲线当下点(history)共用本函数,保证「主页总价 ≡ 曲线当下点」。
export const deriveLiveAccountTotals = (
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  enriched: ReadonlyMap<string, TokenRecord>,
  mode: ValuationMode,
): Map<string, number> => {
  const priceOf = (b: OverviewBalance): number | undefined => {
    const id = fungibleId(b);
    return id ? enriched.get(id)?.price?.unitPrice : undefined;
  };
  const totals = new Map<string, number>();
  for (const account of accounts) {
    let total = 0;
    for (const b of balancesOf(byAccount, account.id)) total += liveValue(b, priceOf(b), mode);
    totals.set(account.id, total);
  }
  return totals;
};

//  —— 24h 盈亏(ADR 0040,TWR 分段)

// 24h 盈亏(ADR 0040)——「过去 24 小时里**因为价格涨跌**赚了多少」,买卖与充提一律剔除。
//
// **算法是时间加权分段(TWR)**,做组合绩效计量的行业标准。在每个能观测到的时刻把窗口切开,
// 每一小段里数量是不变的,只算价格带来的变化,再把各段合起来 —— 买卖和充提全都落在切口上,
// 自然被剔除,**不需要知道成交价**。切口 = 每一次同步的快照,所以同步越勤越准。
//
// **金额与百分比是两套计算,除不通是对的**:金额是各段价值变动之和,百分比是各段收益率**连乘**。

// 窗口:滚动 24 小时,不是自然日(ADR 0040)。
export const GAIN_WINDOW_MS = 24 * 60 * 60 * 1000;
// 基准点允许偏离窗口起点多远。快照稀疏,不会正好落在 24 小时前那一刻。±2 小时。
export const GAIN_BASIS_TOLERANCE_MS = 2 * 60 * 60 * 1000;

// 一条持仓线在某时刻的观测。`value` 是那一刻的冻结市值,`amount` 是数量 —— 单价由两者相除得出。
export interface GainPoint {
  t: number;
  amount: number;
  value: number;
}

// 一条持仓线 = 某账户持有的某个币在窗口内的观测序列(升序)。
// **`points[0]` 必须是基准点**(窗口起点那一刻的观测),由取数层负责。
export interface GainLine {
  points: readonly GainPoint[];
}

export interface Gain {
  amount: number;
  pct: number | null;
  // 摊开给用户看的分段(#445)。**已经合并过**:相邻的、你没动过手的段合成一段。
  segments: GainSegment[];
}

// 只在本模块与 `Gain.segments` 里出现,不单独导出(knip:没有外部消费者就别开 export)。
interface GainSegment {
  from: number;
  to: number;
  openValue: number; // 段初持仓价值(各线之和)—— 这一段的收益率就是拿它当分母
  gain: number;
  pct: number | null;
  // 这一段的起点是不是一个「你动过手」的切口(相对上一段,持有数量变了)。首段恒 false。
  openedByChange: boolean;
}

// 阶梯取值:≤ t 的最后一个观测(与 buildPortfolioHistory 的重建语义一致 —— 快照之间保持不变)。
function at(points: readonly GainPoint[], t: number): GainPoint | undefined {
  let found: GainPoint | undefined;
  for (const p of points) {
    if (p.t > t) break;
    found = p;
  }
  return found;
}

function priceOfPoint(p: GainPoint, fallback: number): number {
  // 数量为 0 时单价无从得出(卖光的那一笔)。沿用上一段的价,于是这一段收益记 0 —— 保守。
  return p.amount !== 0 ? p.value / p.amount : fallback;
}

/**
 * 一组持仓线的 24h 盈亏。传单个 Holding 的各持有点 → 该行的数;传全部线 → 组合层的数。
 * 同一个函数两用,所以「各行相加 = 首页那个数」是结构上成立的,不是靠两边各算一遍碰对。
 *
 * 算不出(没有一条线有合格的基准点)→ `null`,由界面渲染 `—`。
 * 算得出但确实没涨没跌 → `{ amount: 0, pct: 0 }`,界面显示 0。这两件事必须分得开。
 */
export function computeGain24h(lines: readonly GainLine[], now: number): Gain | null {
  const from = now - GAIN_WINDOW_MS;
  // 合格 = 首点(基准点)落在窗口起点的容差内。太旧的基准会把「三天前到现在」冒充成 24 小时。
  const valid = lines.filter(
    (l) => l.points.length > 0 && Math.abs(l.points[0].t - from) <= GAIN_BASIS_TOLERANCE_MS,
  );
  if (valid.length === 0) return null;

  // 统一时间轴:所有合格线的观测时刻并集 + 当下。对齐到同一根轴之后,组合层才能按段汇总。
  const axis = [...new Set([...valid.flatMap((l) => l.points.map((p) => p.t)), now])]
    .filter((t) => t <= now)
    .sort((a, b) => a - b);

  let amount = 0;
  let factor = 1;
  let compounded = false;
  const atoms: GainSegment[] = [];

  for (let i = 0; i + 1 < axis.length; i++) {
    const tA = axis[i];
    const tB = axis[i + 1];
    let segGain = 0;
    let segBase = 0;
    // 这一段的起点相对上一段,持有数量变没变 —— 变了就是「你在这儿动过手」,是个不能合并的切口。
    let changed = false;
    for (const line of valid) {
      const a = at(line.points, tA);
      if (!a) continue; // 这条线在这一段还没开始(它的基准点更晚)
      const b = at(line.points, tB) ?? a;
      const pA = priceOfPoint(a, 0);
      const pB = priceOfPoint(b, pA);
      // **段内数量固定为段初数量** —— 段中途的买卖被剔除的地方就是这里。
      segGain += a.amount * (pB - pA);
      segBase += a.value;
      if (i > 0) {
        const prev = at(line.points, axis[i - 1]);
        if (prev && prev.amount !== a.amount) changed = true;
      }
    }
    amount += segGain;
    // 分母 ≤ 0 的段不进连乘:空仓段没有收益率可言,而 DeFi 净负债段的「收益率」是个反向的数。
    if (segBase > 0) {
      factor *= 1 + segGain / segBase;
      compounded = true;
    }
    atoms.push({
      from: tA,
      to: tB,
      openValue: segBase,
      gain: segGain,
      pct: segBase > 0 ? (segGain / segBase) * 100 : null,
      openedByChange: changed,
    });
  }

  return { amount, pct: compounded ? (factor - 1) * 100 : null, segments: mergeSegments(atoms) };
}

// 相邻的、没动过手的段合成一段(#445)。合并后 `gain` 相加、`openValue` 取头一段的、`pct` 按
// 「合并后的收益 ÷ 合并后的期初」重算 —— **不是把各段百分比加起来**。
function mergeSegments(atoms: readonly GainSegment[]): GainSegment[] {
  const out: GainSegment[] = [];
  for (const seg of atoms) {
    const last = out[out.length - 1];
    if (last && !seg.openedByChange) {
      last.to = seg.to;
      last.gain += seg.gain;
      last.pct = last.openValue > 0 ? (last.gain / last.openValue) * 100 : null;
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

// —— 从快照历史装配持仓线 ——

// 余额历史里的一行(`SnapshotStore.listBalanceHistory` 的投影)。
export interface GainHistoryRow {
  accountId: string;
  takenAt: number;
  tokenId: string | null;
  amount: number;
  usdValue: number;
  // DeFi 分流用。代币聚合那条路不看它们;协议行靠 `kind === "defi"` 挑腿、再从 `metaJson` 读协议名。
  kind?: string;
  metaJson?: string | null;
}

// 当下持仓(overview 的实时现推值,与首屏显示的市值同源)。
export interface GainCurrentRow {
  accountId: string;
  tokenId: string | null;
  amount: number;
  value: number;
}

const pairKey = (accountId: string, tokenId: string) => `${accountId} ${tokenId}`;

/**
 * 把余额历史 + 当下持仓装配成按 `token_id` 分组的持仓线。分组键与 `groupKey` 对齐,
 * 所以 overview 那边直接按 `holding.key` 查得到。
 *
 * ① **同一账户同一个币可能有多行**(EVM 多链、CEX 多 Wallet)—— 先按 (账户, 币, 时刻) 合并。
 * ② **该账户每个快照时刻都要产一个点,哪怕那张快照里没有这个币** —— 补 `(t, 0, 0)`。
 * ③ **末点补当下**,用 overview 的实时值 —— 与首屏那个市值同源。
 */
export function buildGainLines(
  history: readonly GainHistoryRow[],
  current: readonly GainCurrentRow[],
  now: number,
  // 线归到哪个组。**线本身恒是 (账户 × 币)**,变的只是怎么把它们攒成一行。
  groupOf: (row: { accountId: string; tokenId: string }) => string = (row) => row.tokenId,
): Map<string, GainLine[]> {
  const byPair = new Map<string, Map<number, { amount: number; value: number }>>();
  const snapTimes = new Map<string, Set<number>>();
  for (const r of history) {
    if (r.tokenId == null) continue; // 无 token_id 的旧行归不了组(见 groupKey)→ 算不出
    let times = snapTimes.get(r.accountId);
    if (!times) {
      times = new Set();
      snapTimes.set(r.accountId, times);
    }
    times.add(r.takenAt);
    const key = pairKey(r.accountId, r.tokenId);
    let slots = byPair.get(key);
    if (!slots) {
      slots = new Map();
      byPair.set(key, slots);
    }
    const prev = slots.get(r.takenAt);
    slots.set(r.takenAt, {
      amount: (prev?.amount ?? 0) + r.amount,
      value: (prev?.value ?? 0) + r.usdValue,
    });
  }

  const nowByPair = new Map<string, { amount: number; value: number }>();
  for (const c of current) {
    if (c.tokenId == null) continue;
    const key = pairKey(c.accountId, c.tokenId);
    const prev = nowByPair.get(key);
    nowByPair.set(key, {
      amount: (prev?.amount ?? 0) + c.amount,
      value: (prev?.value ?? 0) + c.value,
    });
  }

  const out = new Map<string, GainLine[]>();
  for (const key of new Set([...byPair.keys(), ...nowByPair.keys()])) {
    const sep = key.indexOf(" ");
    const accountId = key.slice(0, sep);
    const tokenId = key.slice(sep + 1);
    const slots = byPair.get(key);
    const times = [...(snapTimes.get(accountId) ?? [])].sort((a, b) => a - b);
    const points: GainPoint[] = [];
    for (const t of times) {
      if (t >= now) continue; // 末点统一由下面那个当下点承担,避免同一时刻两个点
      const slot = slots?.get(t);
      points.push({ t, amount: slot?.amount ?? 0, value: slot?.value ?? 0 });
    }
    const live = nowByPair.get(key);
    points.push({ t: now, amount: live?.amount ?? 0, value: live?.value ?? 0 });
    const group = groupOf({ accountId, tokenId });
    const lines = out.get(group);
    if (lines) lines.push({ points });
    else out.set(group, [{ points }]);
  }
  return out;
}

//  —— 跨账户聚合(按 canonical 代币成 Holding 树)

// symbol 归一(与 tokens 层同口径:trim + 大写)—— 只用在还没有 token_id 的行上(见 groupKey)。
const norm = (s: string): string => s.trim().toUpperCase();

// 聚合输入:一笔持仓 + 其解析结果(ref/展示,由 server 富化)。
export interface AggInput {
  id?: string; // 余额行 id;仅用作没有 token_id 的行的稳定分组键(见 groupKey)
  symbol: string;
  amount: number;
  value: number; // USD(provider 权威;聚合按它求和)
  kind: string; // 归一后的 viewKind:spot | defi | perp_equity | perp_position | utxo
  platform?: string | null;
  account: { id: string; label: string; connectorId: string; platform?: string | null };
  // **归并身份**:写快照时 mint 定死的代币行 id(ADR 0021)。
  tokenId?: string | null;
  name?: string;
  logo?: string; // 已按回退链取好(CGK→provider)
  // 法币身份(ADR 0025 / #271):由该 token 在 fiat 命名者下的 ref 经 fiatCodeOf 推出。
  isFiat?: boolean;
  change24h?: number; // 每币 24h 涨跌(%);仅单 Token 组用于行内 ValueChange
  unitPrice?: number; // 单价(USD;展示用,详情头部)
  marketCapRank?: number; // 市值排名(展示用,详情头部)
}

export interface HoldingSource {
  platform: { id: string; name: string; logo?: string };
  account: { id: string; label: string };
  amount: number;
  value: number;
  kind: string;
}
export interface Holding {
  key: string; // 分组键(去重/稳定用)
  token: {
    id?: string;
    symbol: string;
    name: string;
    logo?: string;
    unitPrice?: number;
    marketCapRank?: number;
    isFiat?: boolean; // 法币身份(ADR 0025);组 = 一个 token → 取组内代表值。
  };
  totalValue: number;
  totalAmount?: number; // 各 source 数量之和(组统一单位,跨链/多源亦可汇总)
  change24h?: number; // 仅单一 Token 组(%,每币 CGK 涨跌)
  // 24h 盈亏(ADR 0040):由 server 读路径按快照历史分段算好后附上,**不在这里算**。
  gain24h?: Gain | null;
  sources: HoldingSource[];
}

// 分组键 = `token_id`。没有 token_id 的行**各自成行**,键 = `账户 + 余额行 id`。
// (只在本模块内用 —— buildCanonicalHoldings / buildTokenValueHistory;不再对外导出,#201 后无外部消费者。)
function groupKey(row: AggInput): string {
  return row.tokenId ?? `no-token:${row.account.id}:${row.id ?? norm(row.symbol)}`;
}

// 进聚合的同质口径:只认现货(含并回的 BTC)。perp 权益不并入(#129)。kind 已由 overview 用 viewKind 归一。
function isEligible(row: AggInput): boolean {
  return row.kind === "spot";
}

interface Acc {
  key: string;
  first: AggInput;
  totalValue: number;
  totalAmount: number;
  logoHint?: string;
  unitPriceHint?: number;
  marketCapRankHint?: number;
  sources: Map<string, HoldingSource>;
}

// 聚合器:eligible 行 → 按代币的 Holding[]。value 降序;组内单一 Token 才给 totalAmount。
export function buildCanonicalHoldings(rows: readonly AggInput[]): Holding[] {
  const acc = new Map<string, Acc>();
  for (const row of rows) {
    if (!isEligible(row)) continue;
    const key = groupKey(row);
    let a = acc.get(key);
    if (!a) {
      a = {
        key,
        first: row,
        totalValue: 0,
        totalAmount: 0,
        sources: new Map(),
      };
      acc.set(key, a);
    }
    a.totalValue += row.value;
    a.totalAmount += row.amount;
    if (!a.logoHint && row.logo) a.logoHint = row.logo;
    if (a.unitPriceHint == null && row.unitPrice != null) a.unitPriceHint = row.unitPrice;
    if (a.marketCapRankHint == null && row.marketCapRank != null)
      a.marketCapRankHint = row.marketCapRank;
    // 持有点的平台单元:链上按链拆(同账户多链 → 多 source),场馆/manual 即连接器本身。
    const platformId = row.platform ?? row.account.connectorId;
    const sk = `${row.account.id}|${platformId}`;
    const existing = a.sources.get(sk);
    if (existing) {
      existing.amount += row.amount;
      existing.value += row.value;
    } else {
      a.sources.set(sk, {
        platform: { id: platformId, name: platformId },
        account: { id: row.account.id, label: row.account.label },
        amount: row.amount,
        value: row.value,
        kind: row.kind,
      });
    }
  }

  const holdings: Holding[] = [];
  for (const a of acc.values()) {
    // 无美元价值(未定价/垃圾空投)→ 不进组合持仓。**判据是「等于 0」,不是「≤ 0」**(#527 发现 2):
    // 负合计的行**要留**(perp 亏穿那笔是真实持仓,`totalUsd` 从来都算着它)。
    if (a.totalValue === 0) continue;
    const sources = [...a.sources.values()].sort((x, y) => y.value - x.value);
    const token = {
      id: a.first.tokenId ?? undefined,
      symbol: a.first.symbol,
      name: a.first.name ?? a.first.symbol,
      logo: a.first.logo ?? a.logoHint,
    };
    holdings.push({
      key: a.key,
      token: {
        id: token.id,
        symbol: token.symbol,
        name: token.name,
        logo: token.logo,
        unitPrice: a.unitPriceHint,
        marketCapRank: a.marketCapRankHint,
        isFiat: a.first.isFiat,
      },
      totalValue: a.totalValue,
      totalAmount: a.totalAmount,
      change24h: a.first.change24h,
      sources,
    });
  }
  return holdings.sort((x, y) => y.totalValue - x.totalValue);
}

//  —— 单币价值历史

// 单币【持仓价值】历史:把历史余额行按 token_id 归属,按 (账户×快照) 汇总【冻结】价值,
// 再复用 buildPortfolioHistory 跨账户阶梯式重建 —— 与主页 hero 同语义。
// 归属用与聚合同一套 `groupKey` / `isEligible`,确保历史 ≡ 当前 Holding。
export interface TokenHistRow extends AggInput {
  takenAt: number; // 该行所属快照时刻(账户 = account.id)
}

export function buildTokenValueHistory(rows: readonly TokenHistRow[], key: string): HistoryPoint[] {
  // 按 (账户, takenAt) 汇总匹配本 Holding 的 eligible 行的冻结 value → 喂阶梯重建。
  const bySnap = new Map<string, SnapshotTotalRow>();
  for (const row of rows) {
    if (!isEligible(row) || groupKey(row) !== key) continue;
    const k = `${row.account.id}|${row.takenAt}`;
    const cur = bySnap.get(k);
    if (cur) cur.totalUsd += row.value;
    else bySnap.set(k, { accountId: row.account.id, takenAt: row.takenAt, totalUsd: row.value });
  }
  return buildPortfolioHistory([...bySnap.values()]);
}

//  —— 首页 tab 条(纯推导)

// 有没有永续 / DeFi:入参就是 `toAccountSections` 的出口,轻请求和列表共用。
type KindSection = {
  perp: { positions: readonly unknown[]; equity: unknown } | null;
  defi: DefiGroup[];
};

export function kindPresence(sections: KindSection[]): {
  hasPerps: boolean;
  hasDefi: boolean;
} {
  return {
    hasPerps: sections.some(
      (s) => s.perp != null && (s.perp.positions.length > 0 || s.perp.equity != null),
    ),
    hasDefi: mergeDefiGroups(sections).length > 0,
  };
}

// 自定义 Tab 的显示名(+ connector 的图):服务端解析好再下发。`#` / `@` 不进这里 —— 渲染时按 kind 加。
export function resolvePinLabel(
  pin: {
    kind: "connector" | "tag" | "account";
    connectorId?: string | null;
    tagId?: string | null;
    accountId?: string | null;
  },
  lookup: {
    tagName: (id: string) => string | undefined;
    accountName: (id: string) => string | undefined;
    connector: (id: string) => { name: string; logo?: string };
  },
): { name: string; logo?: string } {
  if (pin.kind === "tag") return { name: lookup.tagName(pin.tagId ?? "") ?? "" };
  if (pin.kind === "account") return { name: lookup.accountName(pin.accountId ?? "") ?? "" };
  const c = lookup.connector(pin.connectorId ?? "");
  return c.logo ? { name: c.name, logo: c.logo } : { name: c.name };
}

//  —— 组合总览

// 总览读模型(纯 —— 依赖注入,无 Effect、无 Oracle,可脱离 server fn 单测)。
// 持仓区 = 跨账户按 canonical 代币聚合(**只认现货** spot/manual/CEX);DeFi 仓位、perp 权益 + 敞口
// 走每账户次级分区(不进聚合)。总额 = 各账户最新快照 totalUsd 之和。

export interface OverviewInput {
  // 代币富化(按 token_id 查表取回整行)。**由调用方那一次装配供上**(`tokens.enrich(overviewEnrichIds(...))`)。
  enriched: ReadonlyMap<string, TokenRecord>;
  // 每账户现推净值(`deriveLiveAccountTotals`)—— 与主页总价、曲线当下点同源。
  liveTotals: ReadonlyMap<string, number>;
  // 平台(链 ∪ 场馆)展示元数据(`platforms.resolve(overviewChainIds(...))`)。
  platformMeta: ReadonlyMap<string, PlatformMeta>;
  // 值得回源刷价的 token_id 集合(`refreshableTokenIds(overviewEligibleBalances(...))`)—— pricesStale 只在此集合内判脏(#245)。
  refreshableIds: ReadonlySet<string>;
  // 场馆键(manual/exchange:/perp:)→ 连接器自带 name+logo,不查 CoinGecko(#52);链键返回 null → 走 platformMeta。
  connectorMeta?: (key: string) => { name: string; logo?: string } | null;
  // 估值模式(Phase 3,#81)。缺省 self-first(= 旧行为)。
  mode?: ValuationMode;
  // tokenId → 该 token 在 fiat 命名者下的 ref(`fiat/issued:<CODE>`);缺省空 → 无法币。
  fiatRefs?: ReadonlyMap<string, string>;
  // 24h 盈亏的原料(ADR 0040):窗口内的余额历史。缺省 → 不算盈亏(字段缺席)。
  gainHistory?: readonly GainHistoryRow[];
  // 「当下」那一刻。测试注入固定值;生产传 `Date.now()`。
  now?: number;
}

interface Elig {
  account: AccountSafe;
  b: OverviewBalance;
}

export interface OverviewView {
  holdings: ReturnType<typeof buildCanonicalHoldings>;
  sections: {
    account: { id: string; label: string; platform?: { name: string; logo?: string } };
    defi: ReturnType<typeof toAccountSections>["defi"];
    perp: ReturnType<typeof toAccountSections>["perp"];
  }[];
  accountTotals: {
    account: { id: string; label: string };
    totalUsd: number;
    takenAt: number | null;
  }[];
  totalUsd: number;
  // 组合层 24h 盈亏(ADR 0040)。**可选**:首页总览不再算它(#488 票 5),改走独立读取;测试仍可传入 gainHistory 走这条。
  gain24h?: Gain | null;
  holdingsSubtotal: number;
  defiSubtotal: number;
  pricesStale: boolean;
}

// —— 调用点备料用的三个纯 id 收集器(与 buildOverview 内部口径一致,单处定义免得走散)——

// 富化字典该覆盖哪些 token_id:eligible(现货)∪ defi 行。**不含 perp**(perp 富化会改 decorate 的 symbol)。
export function overviewEnrichIds(
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
): string[] {
  const ids = new Set<string>();
  for (const account of accounts) {
    for (const b of balancesOf(byAccount, account.id)) {
      const vk = viewKind(b);
      if ((vk === "spot" || vk === "defi") && b.tokenId) ids.add(b.tokenId);
    }
  }
  return [...ids];
}

// 进聚合的现货余额(喂 refreshableTokenIds 判 pricesStale)。
export function overviewEligibleBalances(
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
): OverviewBalance[] {
  const out: OverviewBalance[] = [];
  for (const account of accounts) {
    for (const b of balancesOf(byAccount, account.id)) {
      if (isFungible(viewKind(b))) out.push(b);
    }
  }
  return out;
}

// 该送去 platforms.resolve 的链键:eligible 行的平台键去重,减去连接器自带展示的场馆键(#52)。
export function overviewChainIds(
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  connectorMeta?: (key: string) => { name: string; logo?: string } | null,
): string[] {
  const platformIds = new Set<string>();
  for (const account of accounts) {
    for (const b of balancesOf(byAccount, account.id)) {
      if (isFungible(viewKind(b))) platformIds.add(b.platform ?? account.connectorId);
    }
  }
  return [...platformIds].filter((id) => !connectorMeta?.(id));
}

export function buildOverview(
  accounts: AccountSafe[],
  byAccount: Map<string, SnapshotWithBalances>,
  {
    enriched,
    liveTotals,
    platformMeta,
    refreshableIds,
    connectorMeta,
    mode = "self-first",
    fiatRefs,
    gainHistory,
    now = Date.now(),
  }: OverviewInput,
): OverviewView {
  // 法币身份:该 token 有 fiat 命名者的 ref、且经 fiatCodeOf 落在白名单内 → 是法币(身份驱动,不看 symbol)。
  const isFiatToken = (tokenId?: string | null): boolean => {
    const ref = tokenId ? fiatRefs?.get(tokenId) : undefined;
    return ref ? fiatCodeOf(ref) != null : false;
  };

  // 1) 摊平所有(账户 × 持仓),挑出进聚合的 eligible —— **只认现货**(spot/manual/CEX/UTXO)。
  const eligible: Elig[] = [];
  for (const account of accounts) {
    for (const b of balancesOf(byAccount, account.id)) {
      if (isFungible(viewKind(b))) eligible.push({ account, b });
    }
  }

  // 2) 富化(附回)→ 组装 AggInput → 聚合。defi 行(展示富化)按行 id 记 change24h。
  const defiFlat = accounts.flatMap((a) =>
    balancesOf(byAccount, a.id).flatMap((b) =>
      viewKind(b) === "defi" && b.tokenId ? [{ b, id: b.tokenId }] : [],
    ),
  );
  const recordOf = (b: { tokenId?: string | null }): TokenRecord | undefined =>
    b.tokenId ? enriched.get(b.tokenId) : undefined;
  const rows = eligible.map((x) => ({ ...x, e: recordOf(x.b) }));
  const aggInputs: AggInput[] = rows.map(({ account, b, e }) => ({
    id: b.id,
    symbol: e?.symbol ?? "",
    amount: b.amount,
    // 读时现推:按 mode + 实时源价(cache-only)重算 —— self-first 下 enrich-not-reprice 行 ≡ 冻结值。
    value: liveValue(b, e?.price?.unitPrice, mode),
    kind: viewKind(b),
    platform: b.platform,
    account: {
      id: account.id,
      label: account.label,
      connectorId: account.connectorId,
      platform: account.platform,
    },
    tokenId: b.tokenId,
    isFiat: isFiatToken(b.tokenId),
    name: e?.name,
    logo: e ? tokenLogoUrl(e) : undefined, // 上游 URL → folio 代理(隐私;见 ADR 0008)
    change24h: e?.price?.change24h,
    unitPrice: e?.price?.unitPrice,
    marketCapRank: e?.price?.marketCapRank,
  }));
  const holdings = buildCanonicalHoldings(aggInputs);

  const withGain = gainHistory != null;
  let portfolioGain: Gain | null | undefined;
  if (withGain) {
    // 24h 盈亏(ADR 0040)。**当下点用现推后的 value**(`aggInputs` 里那个,即首屏显示的市值)。
    const currentRows: GainCurrentRow[] = aggInputs.map((r) => ({
      accountId: r.account.id,
      tokenId: r.tokenId ?? null,
      amount: r.amount,
      value: r.value,
    }));
    const gainLines = buildGainLines(gainHistory, currentRows, now);
    for (const h of holdings) {
      h.gain24h = computeGain24h(gainLines.get(h.key) ?? [], now);
    }
    // 组合层:**同一个函数、喂全部线**。「各行相加 = 首页那个数」于是是结构上成立的。
    portfolioGain = computeGain24h([...gainLines.values()].flat(), now);
  }

  // 读路径装饰:每个 platform key 都给一份展示(命中真名+logo,否则兜底名),cache-only 零网络。
  for (const h of holdings) {
    for (const s of h.sources) {
      const cm = connectorMeta?.(s.platform.id);
      if (cm) {
        s.platform.name = cm.name;
        s.platform.logo = platformLogoUrl(s.platform.id, cm.logo); // 上游 URL → folio 代理(隐私;ADR 0008)
        continue;
      }
      const m = platformMeta.get(s.platform.id);
      if (m) {
        s.platform.name = m.name;
        s.platform.logo = platformLogoUrl(m.key, m.logo); // 上游 URL → folio 代理(隐私;见 ADR 0008 / #20)
      }
    }
  }

  const holdingsSubtotal = holdings.reduce((sum, h) => sum + h.totalValue, 0);
  // 价 stale = 有价但过期,或**认得出来却压根没价**(新层刚建行时)→ 客户端触发一次刷新。
  // **只在刷价集合内判脏**(#245:dust 跳过)。
  const pricesStale = rows.some(
    ({ b, e }) => b.tokenId != null && refreshableIds.has(b.tokenId) && (e?.price?.stale ?? true),
  );

  // 3) 次级分区(每账户 defi 分组 + perp 权益/敞口)。perp 权益不进 Holdings(#129)。
  const defiChange = new Map(defiFlat.map((x) => [x.b.id, enriched.get(x.id)?.price?.change24h]));
  const decorate = (bs: OverviewBalance[]): OverviewBalance[] =>
    bs.map((b) => ({
      ...b,
      symbol: recordOf(b)?.symbol ?? b.symbol,
      ...(defiChange.has(b.id) ? { change24h: defiChange.get(b.id) } : {}),
    }));

  let defiSubtotal = 0;
  const sections = accounts
    .map((account) => {
      const secs = toAccountSections(decorate(balancesOf(byAccount, account.id)));
      defiSubtotal += secs.defi.reduce(
        (s, g) => s + g.rows.reduce((ss, r) => ss + r.usdValue, 0),
        0,
      );
      const cm = connectorMeta?.(account.connectorId);
      return {
        account: {
          id: account.id,
          label: account.label,
          platform: cm
            ? { name: cm.name, logo: platformLogoUrl(account.connectorId, cm.logo) }
            : undefined,
        },
        defi: secs.defi,
        perp: secs.perp,
      };
    })
    // 仅权益、无持仓的 perp 账户也保留(code review #7)。
    .filter(
      (s) =>
        s.defi.length > 0 ||
        (s.perp != null && (s.perp.positions.length > 0 || s.perp.equity != null)),
    );

  if (withGain && gainHistory) {
    // —— DeFi 协议行的 24h 盈亏(ADR 0040 的已知妥协)—— 每个 (账户 × 协议) 当成一条数量恒为 1 的线。
    const defiHistory = gainHistory.filter((r) => r.kind === "defi");
    const defiSlots = new Map<string, { row: GainHistoryRow; gross: number }>();
    for (const r of defiHistory) {
      const protocol = parseDefiMeta(r.metaJson ?? null).protocol ?? DEFI_FALLBACK_PROTOCOL;
      const k = `${defiGainKey(r.accountId, protocol)}|${r.takenAt}`;
      const slot = defiSlots.get(k);
      if (slot) {
        slot.row.usdValue += r.usdValue;
        slot.gross += Math.abs(r.usdValue);
      } else {
        defiSlots.set(k, {
          row: {
            accountId: r.accountId,
            takenAt: r.takenAt,
            tokenId: protocol,
            amount: 1,
            usdValue: r.usdValue,
          },
          gross: Math.abs(r.usdValue),
        });
      }
    }
    const defiGross = new Map<string, { t: number; gross: number }>();
    for (const { row, gross } of defiSlots.values()) {
      const k = defiGainKey(row.accountId, row.tokenId as string);
      const prev = defiGross.get(k);
      if (!prev || row.takenAt < prev.t) defiGross.set(k, { t: row.takenAt, gross });
    }
    const defiCurrent: GainCurrentRow[] = sections.flatMap((s) =>
      s.defi.map((g) => ({
        accountId: s.account.id,
        tokenId: g.protocol,
        amount: 1,
        value: g.rows.reduce((sum, r) => sum + r.usdValue, 0),
      })),
    );
    const defiLines = buildGainLines(
      [...defiSlots.values()].map((x) => x.row),
      defiCurrent,
      now,
      (r) => defiGainKey(r.accountId, r.tokenId),
    );
    for (const s of sections) {
      for (const g of s.defi) {
        const k = defiGainKey(s.account.id, g.protocol);
        const gain = computeGain24h(defiLines.get(k) ?? [], now);
        const gross = defiGross.get(k)?.gross ?? 0;
        g.gain24h =
          gain == null
            ? null
            : {
                amount: gain.amount,
                pct: gross > 0 ? (gain.amount / gross) * 100 : null,
                grossBasis: gross,
              };
      }
    }
  }

  // 4) 每账户净值 + 组合总额(按账户去重)。现推(不落库,liveTotals 已在装配点求得)。
  const accountTotals = accounts.map((account) => ({
    account: { id: account.id, label: account.label },
    totalUsd: liveTotals.get(account.id) ?? 0,
    takenAt: byAccount.get(account.id)?.snapshot.takenAt ?? null,
  }));
  const totalUsd = accountTotals.reduce((s, r) => s + r.totalUsd, 0);

  return {
    holdings,
    sections,
    accountTotals,
    totalUsd,
    ...(withGain ? { gain24h: portfolioGain } : {}),
    holdingsSubtotal,
    defiSubtotal,
    pricesStale,
  };
}

//  —— 账户明细的 24h 盈亏摊分(纯计算部分)

// `loadAccountHoldings` 的纯计算部分(ADR 0040 / ADR 0039)。取数(账户 / 快照 / 富化 / 窗口历史)
// 是调用点的 Effect 适配层;这里只做「有了富化行 + 窗口历史 → 每账户 / 每现货行的 24h 盈亏」。
export interface AccountGainRow {
  account: { id: string };
  archivedAt: number | null;
  balances: readonly { id: string; tokenId?: string | null; amount: number; usdValue: number }[];
}

export type WithAccountHoldingGain<R extends AccountGainRow> = Omit<R, "balances"> & {
  gain24h?: Gain | null;
  balances: Array<R["balances"][number] & { gain24h?: Gain | null }>;
};

export function attachAccountHoldingGains<R extends AccountGainRow>(
  rows: readonly R[],
  history: readonly GainHistoryRow[],
  now: number,
): WithAccountHoldingGain<R>[] {
  // 账户行的 24h 盈亏:**线按账户攒**;抽屉里的现货行按 (账户 × 币) 攒一次。
  const current: GainCurrentRow[] = rows.flatMap((r) =>
    r.balances.map((b) => ({
      accountId: r.account.id,
      tokenId: b.tokenId ?? null,
      amount: b.amount,
      value: b.usdValue,
    })),
  );
  const gainLines = buildGainLines(history, current, now, (r) => r.accountId);
  const perToken = buildGainLines(history, current, now, (r) => `${r.accountId} ${r.tokenId}`);
  const tokenTotals = new Map<string, number>();
  for (const c of current) {
    if (c.tokenId == null) continue;
    const k = `${c.accountId} ${c.tokenId}`;
    tokenTotals.set(k, (tokenTotals.get(k) ?? 0) + c.value);
  }
  const gainByAccount = new Map(
    rows.map((r) => [
      r.account.id,
      // **归档账户不给这个数**(ADR 0039):界面据此整行省略,而不是画 `—`。
      r.archivedAt != null ? undefined : computeGain24h(gainLines.get(r.account.id) ?? [], now),
    ]),
  );

  return rows.map(
    (r): WithAccountHoldingGain<R> => ({
      ...r,
      gain24h: gainByAccount.get(r.account.id),
      balances: r.balances.map((b): R["balances"][number] & { gain24h?: Gain | null } => {
        if (b.tokenId == null || r.archivedAt != null) return { ...b, gain24h: undefined };
        const k = `${r.account.id} ${b.tokenId}`;
        const gain = computeGain24h(perToken.get(k) ?? [], now);
        if (gain == null) return { ...b, gain24h: null };
        // 一个币散在多条链 = 抽屉里的多行,而线是按 (账户 × 币) 的一条。按各行市值占比摊分。
        const total = tokenTotals.get(k) ?? 0;
        const share = total === 0 ? 0 : b.usdValue / total;
        return {
          ...b,
          gain24h: {
            amount: gain.amount * share,
            pct: gain.pct,
            segments: gain.segments.map((seg) => ({
              ...seg,
              openValue: seg.openValue * share,
              gain: seg.gain * share,
            })),
          },
        };
      }),
    }),
  );
}
