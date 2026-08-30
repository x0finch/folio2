import type { Note } from "@folio/connectors-basic";
import type { AccountSafe, SnapshotWithBalances, TabPin, Tag } from "@folio/db";
import {
  fiatCodeOf,
  type PlatformMeta,
  type TokenRecord,
  type TokenRecordPrice,
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
import { pinsInView } from "@/lib/core/accounts-in-view";
import { isFungible, type ViewKind, viewKind } from "@/lib/core/balance-kind";
import {
  buildPortfolioHistory,
  downsampleSeries,
  type HistoryPoint,
  type SnapshotTotalRow,
} from "@/lib/core/history";
import {
  connectorLabelFallback,
  platformLogoUrl,
  tokenLogoUrl,
  toLogoSource,
} from "@/lib/core/logo";
import { displayTokenId, refreshableTokenIds, type TokenEnrichment } from "@/lib/core/token-model";

// 首页 / 组合的**纯计算层**(FOL-45)。跟 `history.ts` 同目录、同风格:无 Effect、无 Oracle、
// 无 cloudflare env —— 喂原料(账户 / 快照 / 富化字典 / 价格字典 / 平台元数据字典)→ 出视图形状。
// 口径只在这一处定义,读接口、同步收官、后台补算都调这里。
//
// 「怎么取原料」(读 Oracle 富化、读 D1 历史)是**调用点的薄适配层**的事(`portfolio/scope.ts`
// 的 `buildScopedOverview`、`portfolio/account-holdings.ts` 等):它们在 Effect 里备好字典,再把
// 这些纯函数当普通函数调。这样这一层既能脱离 server fn 单测,也能在同步收官那一刻被直接算。

// `buildOverview` 真正要的最小快照切片:`takenAt`(账户 totalUsd 那一刻)+ 余额行。快照原料下发
// 浏览器时只发这些(见 `SnapshotView` / `BalanceView`),整包因此瘦一大截。服务端的完整
// `SnapshotWithBalances` 结构上也满足它(`ReadonlyMap` 对值协变),两条路照旧共用同一批算术。
export interface SnapshotSlice {
  snapshot: { takenAt: number };
  balances: OverviewBalance[];
}

const balancesOf = (byAccount: ReadonlyMap<string, SnapshotSlice>, id: string): OverviewBalance[] =>
  byAccount.get(id)?.balances ?? [];

// 富化字典喂 `buildOverview` / 下发到浏览器的**瘦身形状**(FOL-48 优化):只留 buildOverview 真正
// 用到的字段。**logo 上游 URL 不进来** —— 只带「有没有图」的布尔;`tokenLogoUrl` 由 token id 拼
// `/api/logo/token/{id}`,http 与 data: 内嵌图都经代理端点返回(见 `logos/serve.ts`),payload 不带
// 任何 URL。实测把富化字典 raw 砍掉约四分之一。
export interface TokenView {
  id: string;
  symbol: string;
  name: string;
  price?: TokenRecordPrice;
  hasLogo: boolean;
}

// 完整 `TokenRecord`(参考层读出、带上游 URL)→ 瘦身 `TokenView`。服务端两条路(`buildScopedOverview`
// 现算 / 快照原料接口下发)都在装配点经此收窄,于是「浏览器算」与「服务端算」喂进 buildOverview 的
// 是逐值相同的原料。
export function toTokenView(r: TokenRecord): TokenView {
  const { hasLogo } = toLogoSource(r);
  return { id: r.id, symbol: r.symbol, name: r.name, price: r.price, hasLogo };
}

// `tokenEnrichment` 原子资源的瘦身形状:在 `TokenView` 上多带 `hasRef`(刷价门与 enrich 同源)。
export type TokenEnrichmentView = TokenView & { hasRef: boolean };

export function toTokenEnrichmentView(r: TokenRecord): TokenEnrichmentView {
  return { ...toTokenView(r), hasRef: r.ref != null };
}

const enrichmentFromView = (tv: TokenEnrichmentView): TokenEnrichment => ({
  symbol: tv.symbol,
  name: tv.name,
  logo: tokenLogoUrl(tv),
  unitPrice: tv.price?.unitPrice,
  change24h: tv.price?.change24h,
  marketCapRank: tv.price?.marketCapRank,
});

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
  byAccount: ReadonlyMap<string, SnapshotSlice>,
  // 只读现价 —— 结构型入参,`TokenView` 与完整 `TokenRecord` 都喂得进(免得调用点被迫先收窄)。
  enriched: ReadonlyMap<string, { price?: TokenRecordPrice }>,
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

//  —— 24h 盈亏(ADR 0050,两端相减)——

// 24h 盈亏(ADR 0050,取代 ADR 0040)——「**现在的值 − 24 小时前的值**」,全站一个口径
//(百分比基数 = 24 小时前的值)。分段 TWR 弃用(太复杂、解释成本高过它剔掉的那点误差):
// **明确接受充值 / 提现体现在当天盈亏里,这是设计,不是 bug** —— 你充进 10 万,今天就 +10 万,
// 数字与脚下那条净值曲线从此对得上。起点取法见 `snapshots.asOf`:每账户 [now-7d, now-24h] 窗口内
// 最近一张;窗口内无快照 → 起点空(账户不满 24 小时 / 断线超 7 天)。

// 窗口:滚动 24 小时,不是自然日(沿用 ADR 0040 的权衡 —— 币市不休市、零点在哪个时区说不清)。
export const GAIN_WINDOW_MS = 24 * 60 * 60 * 1000;
// 起点回看下界:24 小时前那一刻往前最多再找 7 天(`snapshots.asOf` 的 floor)。断线超 7 天 →
// 窗口内无起点 → 该账户涨跌当 0,不拿极旧的值虚增(ADR 0050 / FOL-43)。
export const GAIN_START_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;

export interface Gain {
  amount: number;
  pct: number | null;
}

/**
 * 两端相减。`start == null` = 没有 24 小时前的观测 → `null`,界面渲染 `—`;与 `{ amount: 0 }`
 * (算得出、确实没涨没跌)必须分得开。分母 ≤ 0(空仓起步 / DeFi 净负债)→ 百分比无从谈起,
 * `pct` 给 `null`,金额照给。
 */
export function endpointGain(start: number | null | undefined, current: number): Gain | null {
  if (start == null) return null;
  const amount = current - start;
  return { amount, pct: start > 0 ? (amount / start) * 100 : null };
}

// 「24 小时前」那一组快照原料复用当前组同一个瘦身形状(`snapshots.asOf` 的一张,或 manual 由账本
// 折算)—— 浏览器一次重建两组(当前 + 24 小时前),两端相减就是盈亏。
export type PrevSlice = SnapshotSlice;

// 起点账户的几张汇总表:每账户总额 / 每现货代币(跨账户与逐账户)/ 每 DeFi 协议净值。
interface StartAggregates {
  accountTotal: Map<string, number>;
  token: Map<string, number>;
  tokenByAccount: Map<string, number>;
  defi: Map<string, number>;
}

const startAggregates = (prevByAccount: ReadonlyMap<string, PrevSlice>): StartAggregates => {
  const accountTotal = new Map<string, number>();
  const token = new Map<string, number>();
  const tokenByAccount = new Map<string, number>();
  const defi = new Map<string, number>();
  for (const [accountId, slice] of prevByAccount) {
    let total = 0;
    for (const b of slice.balances) {
      total += b.usdValue;
      const vk = viewKind(b);
      if (vk === "defi") {
        const protocol = parseDefiMeta(b.metaJson ?? null).protocol ?? DEFI_FALLBACK_PROTOCOL;
        const key = defiGainKey(accountId, protocol);
        defi.set(key, (defi.get(key) ?? 0) + b.usdValue);
        continue;
      }
      // 现货合计与总览聚合同一个口径(`isFungible`):perp 权益不进代币行,两端才对得上。
      if (b.tokenId == null || !isFungible(vk)) continue;
      token.set(b.tokenId, (token.get(b.tokenId) ?? 0) + b.usdValue);
      const line = `${accountId} ${b.tokenId}`;
      tokenByAccount.set(line, (tokenByAccount.get(line) ?? 0) + b.usdValue);
    }
    accountTotal.set(accountId, total);
  }
  return { accountTotal, token, tokenByAccount, defi };
};

// 24h 盈亏是**最简两档**(ADR 0050 / FOL-51 最终口径,取代 FOL-43 那套 new/stale 分档):
//   · **有 24 小时前基准**(`prev`:窗口内有起点快照 / manual 由账本折算得出)→ **两端相减**
//     (差值含这天充/提的值,与净值曲线一致)。
//   · **没有基准**(起点空 —— 新账户 / 新建 manual 不满 24 小时,**或**断线超 7 天)→ **一律 `—`**,不硬算。
// 判据就是一个 `hasPrev`(账户在不在起点组里),账户级 / 组合级 / 持仓级 / DeFi 级**全部**用它,
// 零特例、零组合专属闸。所以不再有 `classifyGain`/new/stale —— 一个 `prevByAccount.has(id)` 就够。

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

// 单币价值历史接口下发的原料(FOL-50 + FOL-46):
//   · 短窗:`rows` = 窗口内该币的原样余额行,浏览器 `buildTokenValueHistory` 重建 + 自适应降采样。
//   · 长窗(1y/all):服务端已重建 + min-max 降采样 → `points`(与总览/账户曲线同一套降采样,
//     payload 随窗口封顶不随历史膨胀);此时 `rows` 为空、`sampled` 为 true。
export interface TokenValueHistoryRow {
  accountId: string;
  takenAt: number;
  amount: number;
  usdValue: number;
  kind: string;
  tokenId: string | null;
  metaJson: string | null;
}
export interface TokenValueHistoryRaw {
  rows: TokenValueHistoryRow[];
  points?: HistoryPoint[];
  sampled?: boolean;
}

// 原样余额行 → buildTokenValueHistory 吃的 TokenHistRow(symbol/label/connectorId 不参与单币曲线,置空)。
// 服务端(长窗重建)与浏览器(短窗重建)共用这一个映射。
export function tokenHistRowsFromRaw(rows: readonly TokenValueHistoryRow[]): TokenHistRow[] {
  return rows.map((r) => ({
    symbol: "",
    amount: r.amount,
    value: r.usdValue,
    kind: viewKind(r),
    account: { id: r.accountId, label: "", connectorId: "" },
    tokenId: r.tokenId,
    takenAt: r.takenAt,
  }));
}

// 原料 → 单币价值曲线。长窗直接用服务端降采样好的 `points`;短窗浏览器重建 + 自适应降采样
// (与 buildAccountValueHistory 的 `sampled ? base : downsampleSeries(base)` 同一口径)。
export function tokenValueHistoryFromRaw(raw: TokenValueHistoryRaw, key: string): HistoryPoint[] {
  if (raw.sampled && raw.points) return raw.points;
  return downsampleSeries(buildTokenValueHistory(tokenHistRowsFromRaw(raw.rows), key));
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

// 首页 tab 条 pin 原料 —— 只含 pin 行 + connector 展示元数据;账户/快照走 overview 缓存,标签走 tagListQuery。
export interface PortfolioTabPinsData {
  pins: TabPin[];
  connectorMeta: [string, { name: string; logo?: string }][];
}

// 首页 tab 条视图 —— `computeHomeTabStrip` 的出参。
export interface HomeTabStripView {
  hasAccounts: boolean;
  hasPerps: boolean;
  hasDefi: boolean;
  pins: {
    id: string;
    kind: "connector" | "tag" | "account";
    connectorId?: string;
    tagId?: string;
    accountId?: string;
    name: string;
    logo?: string;
  }[];
}

/** 从快照原料 + pin 原料 + 标签列表算出首页 tab 条。 */
export function computeHomeTabStrip(
  snapshot: PortfolioSnapshotData,
  tabPins: PortfolioTabPinsData,
  tags: readonly Tag[],
): HomeTabStripView {
  const accounts = snapshot.accounts;
  const inView = new Set(accounts.map((a) => a.id));
  const snapshotMap = new Map(snapshot.snapshots);
  const sections = [...inView]
    .map((id) => snapshotMap.get(id))
    .filter((s): s is SnapshotView => s != null)
    .map((s) =>
      toAccountSections(
        s.balances.map((b) => ({
          id: b.id,
          amount: b.amount,
          usdValue: b.usdValue,
          kind: b.kind,
          metaJson: b.metaJson,
        })),
      ),
    );
  const { hasPerps, hasDefi } = kindPresence(sections);
  const tagIds = new Set(tags.map((t) => t.id));
  const shownPins = pinsInView(tabPins.pins, { accounts, tagIds });
  const tagName = (id: string) => tags.find((t) => t.id === id)?.name;
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.label;
  const connectorMeta = new Map(tabPins.connectorMeta);
  const connector = (id: string) => connectorMeta.get(id) ?? { name: connectorLabelFallback(id) };

  return {
    hasAccounts: accounts.length > 0,
    hasPerps,
    hasDefi,
    pins: shownPins.map((p) => {
      const label = resolvePinLabel(p, { tagName, accountName, connector });
      return {
        id: p.id,
        kind: p.kind,
        connectorId: p.connectorId ?? undefined,
        tagId: p.tagId ?? undefined,
        accountId: p.accountId ?? undefined,
        name: label.name,
        logo: label.logo,
      };
    }),
  };
}

//  —— 组合总览

// 总览读模型(纯 —— 依赖注入,无 Effect、无 Oracle,可脱离 server fn 单测)。
// 持仓区 = 跨账户按 canonical 代币聚合(**只认现货** spot/manual/CEX);DeFi 仓位、perp 权益 + 敞口
// 走每账户次级分区(不进聚合)。总额 = 各账户最新快照 totalUsd 之和。

export interface OverviewInput {
  // 代币富化(按 token_id 查表取回瘦身行)。**由调用方那一次装配供上**(`tokens.enrich(...)` 经
  // `toTokenView` 收窄)—— 服务端现算与浏览器算喂的是同一批 `TokenView`。
  enriched: ReadonlyMap<string, TokenView>;
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
  // 24h 盈亏的原料(ADR 0050):「24 小时前」那一组快照(`snapshots.asOf` + manual 折算)。
  // 缺省 → 不算盈亏(字段缺席)。当前组是 `byAccount`,两组相减就是盈亏。判据只是「账户在不在这组里」
  // (有基准两端相减 / 无基准 `—`),**不看当下时刻**,所以这一层不再需要 `now`。
  prevByAccount?: ReadonlyMap<string, PrevSlice>;
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
  // 组合层 24h 盈亏(ADR 0050,两端相减)。**可选**:传了 `prevByAccount` 才算,字段才出现。
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
  byAccount: ReadonlyMap<string, SnapshotSlice>,
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
  byAccount: ReadonlyMap<string, SnapshotSlice>,
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
  byAccount: ReadonlyMap<string, SnapshotSlice>,
  {
    enriched,
    liveTotals,
    platformMeta,
    refreshableIds,
    connectorMeta,
    mode = "self-first",
    fiatRefs,
    prevByAccount,
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
  const recordOf = (b: { tokenId?: string | null }): TokenView | undefined =>
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
    logo: e ? tokenLogoUrl(e) : undefined, // 有图→拼自家代理 /api/logo/token/{id}(FOL-48 起不再发上游 URL),无图→undefined 显首字母;隐私 ADR 0008
    change24h: e?.price?.change24h,
    unitPrice: e?.price?.unitPrice,
    marketCapRank: e?.price?.marketCapRank,
  }));
  const holdings = buildCanonicalHoldings(aggInputs);

  const withGain = prevByAccount != null;
  let portfolioGain: Gain | null | undefined;
  // 起点各表 + 有基准的账户集,组合 / 持仓 / DeFi 三块共用(DeFi 那块在 sections 建好之后)。
  let start: StartAggregates | undefined;
  // **有 24h 前基准的账户集**(= 起点组里的账户)。没有基准的账户(新建 / 断线)两端都不计 → `—`。
  let prevAccounts: Set<string> | undefined;
  let hasPrevAny = false;
  if (withGain && prevByAccount) {
    const startAgg = startAggregates(prevByAccount);
    start = startAgg;
    // 最简两档:账户在不在起点组里(`start.accountTotal` 的键就是有基准的账户)。
    const prevAccountIds = new Set(
      accounts.filter((a) => startAgg.accountTotal.has(a.id)).map((a) => a.id),
    );
    prevAccounts = prevAccountIds;
    hasPrevAny = prevAccountIds.size > 0;
    // 组合层(ADR 0050 最终口径):只数**有基准**的账户,两端相减 —— 起点 = 各基准总额之和,现值 =
    // 同一批账户的现推净值之和。没有基准的账户(新建 / 断线)整个不计(它的市值仍在 totalUsd 里,
    // 但不进涨跌)。一个有基准的账户都没有 → null(界面 `—`)。
    let startSum = 0;
    let curSum = 0;
    for (const account of accounts) {
      if (!prevAccountIds.has(account.id)) continue;
      startSum += startAgg.accountTotal.get(account.id) ?? 0;
      curSum += liveTotals.get(account.id) ?? 0;
    }
    portfolioGain = hasPrevAny ? endpointGain(startSum, curSum) : null;
    // 持仓层:按 token_id 两端相减。**现值侧与起点侧同口径**(`startAggregates.token` 只收 isFungible
    // 现货、且有 token_id 的行;DeFi 走各自那套)—— 少了这个过滤,同一 token_id 又有现货又有 DeFi/
    // 非同质行时现值会多算、盈亏虚高。现值只数**有基准**账户的行(与组合同口径),起点缺这个币 → 0
    // (基准账户 24h 前没这个币 / 今天在基准账户里新买的那一份)。
    const curByToken = new Map<string, number>();
    for (const r of aggInputs) {
      if (!prevAccountIds.has(r.account.id)) continue;
      if (r.tokenId == null || !isFungible(r.kind as ViewKind)) continue;
      curByToken.set(r.tokenId, (curByToken.get(r.tokenId) ?? 0) + r.value);
    }
    for (const h of holdings) {
      const id = h.token.id;
      // 这个币**有没有基准**:被某个有基准的账户现在持有(`curByToken`)或 24 小时前持有过
      // (`start.token`)。都没有(比如它只存在于一个今天新建 / 断线的账户里)→ 没有可比的起点 → `—`,
      // 与账户级「无基准 → `—`」一致,不拿 `endpointGain(0,0)` 冒充「$0」。无 token_id 的持仓同理算不出。
      const hasBase = id != null && (curByToken.has(id) || startAgg.token.has(id));
      h.gain24h =
        hasBase && id != null
          ? endpointGain(startAgg.token.get(id) ?? 0, curByToken.get(id) ?? 0)
          : null;
    }
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

  if (withGain && start) {
    // —— DeFi 协议行的 24h 盈亏(ADR 0050,两端相减)—— 该协议现在的净值 − 24 小时前的净值,
    // 与全站同一口径(旧的「按总敞口分母」废止)。`start`(24 小时前那张的协议净值)一路带着,
    // 好让 `mergeDefiGroups` 跨账户合并时按「合并后的收益 ÷ 合并后的起点」重算百分比。
    for (const s of sections) {
      const hasPrevAcc = prevAccounts?.has(s.account.id) ?? false;
      for (const g of s.defi) {
        if (!hasPrevAny) {
          g.gain24h = null;
          continue;
        }
        const key = defiGainKey(s.account.id, g.protocol);
        // 无基准账户(新建 / 断线超 7 天)两端都不计 → 涨跌当 0。
        const startVal = hasPrevAcc ? (start.defi.get(key) ?? 0) : 0;
        const current = hasPrevAcc ? g.rows.reduce((sum, r) => sum + r.usdValue, 0) : 0;
        const eg = endpointGain(startVal, current);
        g.gain24h = eg == null ? null : { amount: eg.amount, pct: eg.pct, start: startVal };
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

//  —— 快照原料 → 总览(浏览器里算,FOL-48)——

// 余额行下发到浏览器的**瘦身形状**(FOL-48 优化):只留 `buildOverview` / `deriveLiveAccountTotals`
// 真正读到的列。**砍掉两列**:`snapshotId`(payload 已按 account 分组,前端不做关联)与 `note`
// (balance 级展示 note 只在账户抽屉那条路渲染,首页总览不显 —— 见 `toAccountSections` 的 spot 分区被
// buildOverview 丢弃)。`metaJson` 留着:defi/perp 的 `parseDefiMeta` / `PerpEquityMeta` / `viewKind`
// 全靠它。实测把快照那一段 raw 砍掉约一半。
export interface BalanceView {
  id: string; // 无 token_id 的行的分组键;defiChange 按它挂 change24h;DefiRow.id —— 必须留
  amount: number;
  usdValue: number;
  kind: string;
  selfPrice?: number | null; // 读时现推的原料(liveValue)
  platform?: string | null; // 聚合来源单元 / refreshableTokenIds 判 dust
  tokenId?: string | null; // 富化查表 / 聚合身份 / 法币身份 / pricesStale
  metaJson: string | null; // defi/perp meta 解析
}

// 快照下发的**瘦身包裹**:只发 `takenAt`(账户 totalUsd 那一刻;`accountTotals` 用)+ 余额行。
// 完整包裹里的 snapshot id/accountId/totalUsd/note/noteHash + 账户级 note[] 前端一概不读。
export interface SnapshotView {
  takenAt: number;
  balances: BalanceView[];
}

// 完整 `SnapshotWithBalances`(服务端读出)→ 瘦身 `SnapshotView`。装配点投影,把前端用不到的列挡在
// payload 外。`SnapshotBalanceView` 结构上满足 `OverviewBalance`,逐行只挑用到的列。
export function toSnapshotView(s: SnapshotWithBalances): SnapshotView {
  return {
    takenAt: s.snapshot.takenAt,
    balances: s.balances.map((b) => ({
      id: b.id,
      amount: b.amount,
      usdValue: b.usdValue,
      kind: b.kind,
      selfPrice: b.selfPrice,
      platform: b.platform,
      tokenId: b.tokenId,
      metaJson: b.metaJson,
    })),
  };
}

// 服务端发的一份「当前快照原料」(方案 C:名字 / 库里当前价内联发下来;logo 只发「有没有图」布尔,
// URL 由 token id 在浏览器里拼,见 `TokenView`)。Map 走 entries
// 过线,客户端在 `select` 里重建 Map 再调 `buildOverview` —— 首页总额 / 持仓 / 各小计 / pricesStale
// 全部在浏览器里算,读接口只取行 + 备料,不做聚合。
export interface PortfolioSnapshotData {
  accounts: AccountSafe[];
  // byAccount 的 entries(accountId → 瘦身快照:takenAt + 瘦身余额行,含 manual 注入)。见 `SnapshotView`。
  snapshots: [string, SnapshotView][];
  // 「24 小时前」那一组(`snapshots.asOf` + manual 折算),与当前组并列发下来 —— 浏览器一次
  // 重建两组、两端相减算 24h 盈亏(ADR 0050)。窗口内没起点快照的账户不在内(涨跌当 0 / `—`)。
  prevSnapshots: [string, SnapshotView][];
  // 富化字典 entries(token_id → 瘦身行:名字 / 价格 / change24h / 有没有图)。**不含上游 logo URL**
  // (FOL-48:有 id 就能拼 `/api/logo/token/{id}`)。
  enriched: [string, TokenView][];
  // 平台(链)展示元数据 entries(场馆键不在内 —— 那些走 connectorMeta)。
  platformMeta: [string, PlatformMeta][];
  // 场馆键(connectorId)→ 连接器自带 name + logo 的 entries(链键不在内 → 走 platformMeta)。
  connectorMeta: [string, { name: string; logo?: string }][];
  // 法币身份 ref 的 entries(token_id → `fiat/issued:<CODE>`)。
  fiatRefs: [string, string][];
  // 估值口径(self-first / source-first)。
  mode: ValuationMode;
  // 服务端装配那一刻(`Date.now()`)。**下发而不是 select 里现取**:24h 盈亏要用它分「新账户 /
  // 断线」,SSR 与补水两遍读同一个固定值才不会 hydration mismatch。
  now: number;
}

// 瘦身快照包裹 entries → buildOverview 要的最小切片(takenAt 挪回 `snapshot.takenAt` 的位置)。
const sliceMap = (entries: [string, SnapshotView][]): Map<string, SnapshotSlice> =>
  new Map(
    entries.map(([id, s]) => [id, { snapshot: { takenAt: s.takenAt }, balances: s.balances }]),
  );

// 客户端把原料算成总览:重建两组快照(当前 + 24 小时前)→ 纯算 liveTotals / refreshableIds →
// `buildOverview`。总额 / 持仓 / 各小计 / pricesStale 与服务端 `buildScopedOverview` 逐值一致
// (共用同一个 `buildOverview`);24h 盈亏(ADR 0050)由两组快照两端相减,浏览器里算。
export function overviewFromSnapshotData(raw: PortfolioSnapshotData): OverviewView {
  const byAccount = sliceMap(raw.snapshots);
  const prevByAccount = sliceMap(raw.prevSnapshots);
  const enriched = new Map(raw.enriched);
  const platformMeta = new Map(raw.platformMeta);
  const connectorMeta = new Map(raw.connectorMeta);
  const fiatRefs = new Map(raw.fiatRefs);
  const liveTotals = deriveLiveAccountTotals(raw.accounts, byAccount, enriched, raw.mode);
  const refreshableIds = new Set(
    refreshableTokenIds(overviewEligibleBalances(raw.accounts, byAccount)),
  );
  return buildOverview(raw.accounts, byAccount, {
    enriched,
    liveTotals,
    platformMeta,
    refreshableIds,
    connectorMeta: (key) => connectorMeta.get(key) ?? null,
    mode: raw.mode,
    fiatRefs,
    prevByAccount,
  });
}

// 「刚加账户、首次同步还没落地」的时间窗。**这个窗是为了把「短暂的首次同步中」与「从没同步成功」
// 分开**(见 `isFirstSyncPending`):同步轮几秒到一分钟内就会写下第一张快照,给足 10 分钟余量。
export const FIRST_SYNC_WINDOW_MS = 10 * 60 * 1000;

// **首次同步中**:组合里有**刚建的**账户,但一张快照都还没有(没有任何账户同步落地 —— 含手记注入
// 的合成快照也算)。这一刻 `overviewFromSnapshotData` 会算出总额 0 / 空持仓,与「真的空组合(零账户)」
// 在屏幕上一模一样 —— 首页据此显加载态而不是把「还不知道」画成 $0。
//
// **「刚建的」这一档是必须的,不是优化**(FOL-51 code-review 修的回归):光判「有账户 + 无快照」对
// 「从没同步成功过」的账户(坏凭据 / 从没同步成)**永真** → hero 永久卡加载骨架,轮询用尽也不解除。
// 加账户几秒内同步就会落第一张快照;超过 `FIRST_SYNC_WINDOW_MS` 还没有,那不是「还在同步」,是
// 「同步不成」—— 该显 $0 / 空态(账户在,值是 0),让用户去查凭据,而不是盯着一片加载。
// 判据全从快照原料读:`accounts` 里有一个 `createdAt` 落在窗口内、且 `snapshots` 全空。
export function isFirstSyncPending(raw: PortfolioSnapshotData | undefined): boolean {
  if (!raw || raw.accounts.length === 0 || raw.snapshots.length > 0) return false;
  return raw.accounts.some((a) => raw.now - a.createdAt < FIRST_SYNC_WINDOW_MS);
}

//  —— 账户明细的 24h 盈亏(两端相减,纯计算部分)

// `loadAccountHoldings` 的纯计算部分(ADR 0050 / ADR 0039)。取数(账户 / 当下快照 / 富化 /
// 「24 小时前」那一组)是调用点的 Effect 适配层;这里只做「有了富化行 + 起点组 → 每账户 /
// 每现货行的 24h 盈亏」,两端相减(现值 − 24 小时前值)。
export interface AccountGainRow {
  account: { id: string };
  archivedAt: number | null;
  // 该账户当下净值(冻结口径:最新快照 totalUsd)—— 账户级两端相减的「现值」那一端。
  totalUsd: number;
  // `kind`/`metaJson` 是逐币盈亏两端同口径要用的:现值侧只聚合 isFungible 现货行(与起点侧一致),
  // 否则同一 token_id 又有现货又有 DeFi/perp 行时现值会多算、盈亏虚高。
  balances: readonly {
    id: string;
    tokenId?: string | null;
    amount: number;
    usdValue: number;
    kind: string;
    metaJson?: string | null;
  }[];
}

export type WithAccountHoldingGain<R extends AccountGainRow> = Omit<R, "balances"> & {
  gain24h?: Gain | null;
  balances: Array<R["balances"][number] & { gain24h?: Gain | null }>;
};

// `prevByAccount` = 「24 小时前」那一组(`snapshots.asOf` + manual 折算)。**最简两档**(与组合级同一套):
//   · 有基准(`prev != null`)→ 两端相减(账户级 + 逐现货行按市值占比摊分)。
//   · 无基准(新账户 / 新建 manual 不满 24h,或断线超 7 天)→ 一律 `null`(`—`),不硬算。
// 归档账户两级都 `undefined`(ADR 0039:界面据此整行省略)。非同质行(defi/perp)逐行盈亏也 `undefined`
//(各自分区给)。
export function attachAccountHoldingGains<R extends AccountGainRow>(
  rows: readonly R[],
  prevByAccount: ReadonlyMap<string, PrevSlice>,
): WithAccountHoldingGain<R>[] {
  return rows.map((r): WithAccountHoldingGain<R> => {
    // 逐行盈亏只对 isFungible 现货行有意义(DeFi/perp 行的盈亏由各自的分区给);非同质行 → undefined。
    const spotOf = (b: R["balances"][number]): boolean =>
      b.tokenId != null && isFungible(viewKind(b));
    if (r.archivedAt != null) {
      return {
        ...r,
        gain24h: undefined,
        balances: r.balances.map((b) => ({ ...b, gain24h: undefined })),
      };
    }
    const prev = prevByAccount.get(r.account.id);
    // 无基准 → 一律 `—`:账户级 null,现货行 null,非现货行 undefined。
    if (prev == null) {
      return {
        ...r,
        gain24h: null,
        balances: r.balances.map((b) => ({ ...b, gain24h: spotOf(b) ? null : undefined })),
      };
    }
    // 有基准:起点各表(账户总额 + 逐现货代币值)从那张起点快照汇。
    let startTotal = 0;
    const startToken = new Map<string, number>();
    for (const b of prev.balances) {
      startTotal += b.usdValue;
      if (b.tokenId != null && isFungible(viewKind(b))) {
        startToken.set(b.tokenId, (startToken.get(b.tokenId) ?? 0) + b.usdValue);
      }
    }
    // 现值:逐 (账户 × 币) 现货合计 —— **与起点侧同口径**(只 isFungible 现货、有 token_id 的行),
    // 一个币散在多条链 = 抽屉里多行,而两端相减是按币一条。
    const curToken = new Map<string, number>();
    for (const b of r.balances) {
      if (!spotOf(b)) continue;
      const id = b.tokenId as string;
      curToken.set(id, (curToken.get(id) ?? 0) + b.usdValue);
    }
    return {
      ...r,
      gain24h: endpointGain(startTotal, r.totalUsd),
      balances: r.balances.map((b): R["balances"][number] & { gain24h?: Gain | null } => {
        if (!spotOf(b)) return { ...b, gain24h: undefined };
        const id = b.tokenId as string;
        const total = curToken.get(id) ?? 0;
        // 起点缺这个币 → 0(今天新买,整份算成今天赚的);两端相减。
        const gain = endpointGain(startToken.get(id) ?? 0, total);
        if (gain == null) return { ...b, gain24h: null };
        // 按各行市值占比把那一条币的盈亏摊回具体这一行(pct 是币级的,不摊)。
        const share = total === 0 ? 0 : b.usdValue / total;
        return { ...b, gain24h: { amount: gain.amount * share, pct: gain.pct } };
      }),
    };
  });
}

// 客户端 hour-floor 锚点(FOL-54):快照 / 盈亏窗口 key 用同一刻度,避免 SSR 与补水各算各的 now。
export const floorToHour = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000;

//  —— 原子资源 → 快照原料(浏览器合并,FOL-54 / FOL-56)——

type ConnectorCatalogEntry = { label: string; logo?: string };

/** 总览 connector 展示元数据:场馆键走目录,链键落空 → `platformMeta`。 */
export const connectorMetaForOverview = (
  accounts: readonly { id: string; connectorId: string }[],
  snapshotsNow: readonly { accountId: string; balances: BalanceView[] }[],
  catalog: Readonly<Record<string, ConnectorCatalogEntry>>,
): [string, { name: string; logo?: string }][] => {
  const keys = new Set<string>();
  const byAccount = new Map(snapshotsNow.map((s) => [s.accountId, s] as const));
  for (const account of accounts) {
    keys.add(account.connectorId);
    for (const b of byAccount.get(account.id)?.balances ?? []) {
      keys.add(b.platform ?? account.connectorId);
    }
  }
  const out: [string, { name: string; logo?: string }][] = [];
  for (const key of keys) {
    const entry = catalog[key];
    if (entry) out.push([key, { name: entry.label, logo: entry.logo }]);
  }
  return out;
};

/** 原子资源在浏览器合并 → `PortfolioSnapshotData` → `overviewFromSnapshotData`。 */
export function assemblePortfolioSnapshotData(args: {
  accounts: readonly AccountSafe[];
  snapshotsNow: readonly { accountId: string; takenAt: number; balances: BalanceView[] }[];
  snapshotsPrev: readonly { accountId: string; takenAt: number; balances: BalanceView[] }[];
  enriched: ReadonlyMap<string, TokenEnrichmentView>;
  mode: ValuationMode;
  platformMeta: readonly [string, PlatformMeta][];
  connectorMeta: readonly [string, { name: string; logo?: string }][];
  fiatRefs: readonly [string, string][];
  now: number;
}): PortfolioSnapshotData {
  return {
    accounts: [...args.accounts],
    snapshots: args.snapshotsNow.map(
      (s) => [s.accountId, { takenAt: s.takenAt, balances: s.balances }] as const,
    ),
    prevSnapshots: args.snapshotsPrev.map(
      (s) => [s.accountId, { takenAt: s.takenAt, balances: s.balances }] as const,
    ),
    enriched: [...args.enriched].map(
      ([id, tv]) =>
        [
          id,
          { id: tv.id, symbol: tv.symbol, name: tv.name, price: tv.price, hasLogo: tv.hasLogo },
        ] as const,
    ),
    platformMeta: [...args.platformMeta],
    connectorMeta: [...args.connectorMeta],
    fiatRefs: [...args.fiatRefs],
    mode: args.mode,
    now: args.now,
  };
}

/** 纯函数:原子原料 → 总览(与首页 `usePortfolioOverview` 的 `select` 同口径)。 */
export function portfolioOverviewFromAtoms(
  args: Parameters<typeof assemblePortfolioSnapshotData>[0],
): OverviewView & { pending: boolean } {
  const raw = assemblePortfolioSnapshotData(args);
  return { ...overviewFromSnapshotData(raw), pending: isFirstSyncPending(raw) };
}

//  —— 账户明细:发原料 + 浏览器算(与首页 `overviewFromSnapshotData` 同路,FOL-44 收尾)

export interface AccountSnapshotEntry {
  accountId: string;
  takenAt: number;
  totalUsd: number;
  note?: Note[];
  balances: BalanceView[];
}

const enrichBalanceRows = (
  balances: BalanceView[],
  enriched: ReadonlyMap<string, TokenEnrichmentView>,
): OverviewBalance[] =>
  balances.map((b) => {
    const id = displayTokenId(b);
    const tv = id ? enriched.get(id) : undefined;
    return tv ? { ...b, ...enrichmentFromView(tv) } : b;
  });

const pricesStaleForRows = (
  rows: readonly { archivedAt: number | null; balances: BalanceView[] }[],
  enriched: ReadonlyMap<string, TokenEnrichmentView>,
): boolean => {
  const refreshable = new Set(refreshableTokenIds(rows.flatMap((r) => r.balances)));
  for (const row of rows) {
    if (row.archivedAt != null) continue;
    for (const b of row.balances) {
      const id = displayTokenId(b);
      if (!id || !refreshable.has(id)) continue;
      const tv = enriched.get(id);
      if (tv?.hasRef && tv.price?.stale !== false) return true;
    }
  }
  return false;
};

/** 单行是否有过期价(含归档行 —— 汇总那步再收窄,行本身照实)。 */
const rowPricesStale = (
  balances: BalanceView[],
  enriched: ReadonlyMap<string, TokenEnrichmentView>,
): boolean => {
  const refreshable = new Set(refreshableTokenIds(balances));
  for (const b of balances) {
    const id = displayTokenId(b);
    if (!id || !refreshable.has(id)) continue;
    const tv = enriched.get(id);
    if (tv?.hasRef && tv.price?.stale !== false) return true;
  }
  return false;
};

// 账户页原子资源在浏览器合并 → `AccountHoldingsData` → `accountRowsFromRaw`(FOL-54 / FOL-55)。
export function assembleAccountHoldingsData(args: {
  accounts: readonly { id: string; label: string; archivedAt: number | null }[];
  snapshotsNow: readonly AccountSnapshotEntry[];
  snapshotsPrev: readonly AccountSnapshotEntry[];
  mode: ValuationMode;
  enriched: ReadonlyMap<string, TokenEnrichmentView>;
}): AccountHoldingsData {
  const nowByAccount = new Map(args.snapshotsNow.map((s) => [s.accountId, s]));
  const rows = args.accounts.map((account) => {
    const latest = nowByAccount.get(account.id);
    const balances = enrichBalanceRows(latest?.balances ?? [], args.enriched);
    return {
      account: { id: account.id, label: account.label },
      archivedAt: account.archivedAt,
      totalUsd: latest?.totalUsd ?? 0,
      takenAt: latest?.takenAt ?? null,
      note: latest?.note,
      balances,
      pricesStale: rowPricesStale(balances, args.enriched),
    };
  });
  const prevSnapshots = args.snapshotsPrev.map((s): [string, SnapshotView] => [
    s.accountId,
    { takenAt: s.takenAt, balances: s.balances },
  ]);
  return {
    rows,
    prevSnapshots,
    mode: args.mode,
    pricesStale: pricesStaleForRows(rows, args.enriched),
  };
}

// 账户明细「一行」的原料:冻结快照值 + 富化(含 `unitPrice`)。**活跃行的现价重算 + 24h 盈亏
// 不在这里做,在浏览器 `accountRowsFromRaw` 里做** —— 服务端只发料,和首页那条读接口一个方向。
interface AccountHoldingRow {
  account: { id: string; label: string };
  archivedAt: number | null;
  // 冻结快照总额:归档行原样用(封存,ADR 0039);活跃行浏览器按 `liveValue` 重算后覆盖。
  totalUsd: number;
  takenAt: number | null;
  note?: Note[];
  balances: OverviewBalance[];
  pricesStale: boolean;
}

// 账户明细读接口的原料(`getAccountHoldings` 的出参)。**只发料,不聚合、不重算、不算盈亏** ——
// 那三步全在浏览器 `accountRowsFromRaw` 里(与首页 `getPortfolioSnapshotData` 同一个方向)。
export interface AccountHoldingsData {
  rows: AccountHoldingRow[];
  // 「24 小时前」那一组(`snapshots.asOf` + manual 折算),浏览器与当前组两端相减算 24h 盈亏。
  prevSnapshots: [string, SnapshotView][];
  // 估值口径(self-first / source-first)—— 现价重算用它,与首页同一个 mode。
  mode: ValuationMode;
  pricesStale: boolean;
}

// 账户明细在浏览器算完的视图:每账户带现价重算的总额/持仓 + 两端相减的 24h 盈亏。
export interface AccountHoldingsView {
  rows: WithAccountHoldingGain<AccountHoldingRow>[];
  pricesStale: boolean;
}

// 浏览器把账户明细原料算成行:活跃账户逐行 `liveValue` 现价重算(与首页 `deriveLiveAccountTotals`
// 同口径:盯市行取实时源价、CEX 自带价行 self-first 下≡冻结、非同质/无价回退冻结),账户总额 =
// 重算后各行之和;归档账户不现推(封存值取自快照,ADR 0039)。随后两端相减贴上 24h 盈亏
// (`attachAccountHoldingGains`:当前端 = 重算后的现值,起点端 = 24 小时前那张冻结快照)。
export function accountRowsFromRaw(raw: AccountHoldingsData): AccountHoldingsView {
  const prevByAccount = sliceMap(raw.prevSnapshots);
  const priced = raw.rows.map((r): AccountHoldingRow => {
    if (r.archivedAt != null) return r;
    const balances = r.balances.map((b) => ({
      ...b,
      usdValue: liveValue(b, isFungible(viewKind(b)) ? b.unitPrice : undefined, raw.mode),
    }));
    return { ...r, balances, totalUsd: balances.reduce((sum, b) => sum + b.usdValue, 0) };
  });
  return { rows: attachAccountHoldingGains(priced, prevByAccount), pricesStale: raw.pricesStale };
}
