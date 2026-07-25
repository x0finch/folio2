import type { TokenGroup, TokenRef } from "@folio/tokens";
import { chainNamerOf } from "./token-ref";

// symbol 归一(与 tokens 层同口径:trim + 大写)—— 仅用于未解析行的分组键/身份。
const norm = (s: string): string => s.trim().toUpperCase();

// 纯逻辑(无 server-only import → 可单测)。把跨账户的持仓行按【规范代币】聚合成 Holding 树。
// 设计见 docs/adr 0001–0003;术语见 CONTEXT.md。
//   · 白名单(进聚合):spot / utxo(BTC)/ CEX 现货(kind=spot)/ perp 权益(isMargin) —— ADR-0003。kind 已由 overview 用 viewKind 归一。
//   · 归并键四级(永不裸 symbol,ADR-0002):group → token(ref)→ tokenRef(精确合约)→ account:symbol。
//   · HoldingSource 粒度 = 账户 × 平台单元:链上按链拆(tokenRef 的 eip155/chain 前缀),其余按账户/场馆。
//   · 表头 totalAmount = 组内各 source 数量之和。组是「同一逻辑资产」(displaySymbol 统一单位),故跨链/
//     多源(桥接家族)也可汇总 —— 如 USDT 跨多链合计总枚数。change24h 仍仅单一身份组给(多身份逐币涨跌不同)。

// 聚合输入:一笔持仓 + 其解析结果(group/ref/展示,由 server 富化)。
export interface AggInput {
  symbol: string;
  amount: number;
  value: number; // USD(provider 权威;聚合按它求和)
  kind: string; // 归一后的 viewKind:spot | defi | perp_equity | perp_position | utxo
  tokenRef?: string | null;
  isMargin?: boolean; // perp 权益(保证金)—— 进聚合但明细标注
  account: { id: string; label: string; connectorId: string; network?: string | null };
  group?: TokenGroup; // 命中种子的展示分组
  tokenId?: string; // 内部代币行 id(vendor 中立归并身份,#73;富化命中 store 才有)
  ref?: TokenRef | null; // 该源对此币的寻址引用(vendor tag;归并回退用,内部 id 缺失时)
  name?: string;
  logo?: string; // 已按回退链取好(CGK→provider)
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
  isMargin: boolean;
}
export interface Holding {
  key: string; // 分组键(去重/稳定用)
  // unitPrice/marketCapRank:详情头部 meta 展示用,取代表行(a.first);缺则不显。
  token: {
    id?: string;
    symbol: string;
    name: string;
    logo?: string;
    unitPrice?: number;
    marketCapRank?: number;
  };
  totalValue: number;
  totalAmount?: number; // 各 source 数量之和(组统一单位,跨链/多源亦可汇总)
  change24h?: number; // 仅单一 Token 组(%,每币 CGK 涨跌)
  sources: HoldingSource[];
}

// 持有点的平台 key:
//   · 链上:tokenRef 的链命名者(eip155:<id> / <slug>);同账户多链 → 多 source。
//   · 场馆/manual:平台单元 = 连接器本身,key 即 connectorId(binance/okx/hyperliquid/manual);
//     name+logo 读路径取连接器自带(#53)。
// 「是不是链」看 tokenRef 的右半边(见 chainNamerOf),不查表;不透明 id 形的 ref
// (coingecko/<id> 选币、binance/USDC 场馆命名)不是链 → 落账户平台。
function platformIdOf(row: AggInput): string {
  return chainNamerOf(row.tokenRef) ?? row.account.connectorId;
}

// —— 下面两个产的是【归并键】,不是 tokenRef ——
// 相似之处只在长相(都带 `xxx:` 前缀),用途完全不同,别混:
//   · tokenRef(`bitcoin/native`、`binance/USDC`,见 @folio/oracle-ref)回答「谁管这个币叫什么」,
//     由 provider 产、落库(`snapshot_balances.token_ref`)、跨进程稳定。
//   · 归并键回答「这两笔持仓算不算界面上的同一行」,**纯运行时**、不落库,前缀标的是这一级取自哪儿
//     (group / token / tk / as / sym),优先级从高到低。tokenRef 只是其中一级的取值(`tk:` 那级)。
// 换句话说:tokenRef 是身份,归并键是分组决策 —— 一个 tokenRef 可能因为解析出了 tokenId 而落到
// 更高的 `token:` 级,压根用不上 `tk:`。

// 单笔持仓的"代币身份"(用于判断组内是否单一 Token → 决定是否给 totalAmount)。
function tokenIdentity(row: AggInput): string {
  if (row.tokenId) return row.tokenId; // vendor 中立内部 id(优先;换源不碎)
  if (row.ref) return row.ref; // 回退:已解析 ref 但未命中 store 记录
  if (row.tokenRef) return row.tokenRef;
  return `sym:${norm(row.symbol)}`;
}

// 四级归并键(ADR-0002:任何一级都不含裸 symbol)。导出供单币价值历史(token-history)按同一身份匹配历史行。
export function holdingKey(row: AggInput): string {
  if (row.group) return `group:${row.group.id}`;
  if (row.tokenId) return `token:${row.tokenId}`; // vendor 中立内部 id(优先)
  if (row.ref) return `token:${row.ref}`; // 回退:已解析 ref 但未命中 store 记录
  if (row.tokenRef) return `tk:${row.tokenRef}`;
  return `as:${row.account.id}:${norm(row.symbol)}`;
}

// 导出供 token-history 复用(历史行归属同一口径)。
export function isEligible(row: AggInput): boolean {
  // 进聚合的同质口径:现货(含并回的 BTC)/ perp 权益(isMargin)。kind 已由 overview 用 viewKind 归一。
  return row.kind === "spot" || row.isMargin === true;
}

interface Acc {
  key: string;
  first: AggInput;
  identities: Set<string>;
  totalValue: number;
  totalAmount: number;
  logoHint?: string; // 首个带 logo 的成员(组 logo 缺省时兜底)
  // 首个带价/排名的成员(组统一资产 → 单价一致):多源组里 a.first 可能是未定价的桥接/孤儿变体,
  // 取「首个有值」而非 a.first,避免头部价格/排名随行序偶发隐藏(与 logoHint 同理)。
  unitPriceHint?: number;
  marketCapRankHint?: number;
  // 持有点按 (account, platform) 去重合并(红线 3:同地址双 provider 覆盖)。
  sources: Map<string, HoldingSource>;
}

// 聚合器:eligible 行 → 按代币的 Holding[]。value 降序;组内单一 Token 才给 totalAmount。
export function buildCanonicalHoldings(rows: readonly AggInput[]): Holding[] {
  const acc = new Map<string, Acc>();
  for (const row of rows) {
    if (!isEligible(row)) continue;
    const key = holdingKey(row);
    let a = acc.get(key);
    if (!a) {
      a = {
        key,
        first: row,
        identities: new Set(),
        totalValue: 0,
        totalAmount: 0,
        sources: new Map(),
      };
      acc.set(key, a);
    }
    a.identities.add(tokenIdentity(row));
    a.totalValue += row.value;
    a.totalAmount += row.amount;
    if (!a.logoHint && row.logo) a.logoHint = row.logo;
    if (a.unitPriceHint == null && row.unitPrice != null) a.unitPriceHint = row.unitPrice;
    if (a.marketCapRankHint == null && row.marketCapRank != null)
      a.marketCapRankHint = row.marketCapRank;
    const platformId = platformIdOf(row);
    const sk = `${row.account.id}|${platformId}`;
    const existing = a.sources.get(sk);
    if (existing) {
      existing.amount += row.amount;
      existing.value += row.value;
      existing.isMargin = existing.isMargin || row.isMargin === true;
    } else {
      a.sources.set(sk, {
        // name = key 占位;真名 + logo 由 server 读路径 platforms.resolve 装饰(每个 key 必有兜底)。
        platform: { id: platformId, name: platformId },
        account: { id: row.account.id, label: row.account.label },
        amount: row.amount,
        value: row.value,
        kind: row.kind,
        isMargin: row.isMargin === true,
      });
    }
  }

  const holdings: Holding[] = [];
  for (const a of acc.values()) {
    // 无美元价值(未定价/垃圾空投)→ 不进组合持仓:对净值无贡献,却会污染值排序、best/worst
    // 24h 择取(deriveHeroMetrics 只看 change24h,不看 value)与列表(挤满小额)。账户详情走
    // toAccountSections 原始余额,仍保留这些行 —— 此处只清「按代币的组合视角」。
    if (a.totalValue <= 0) continue;
    const g = a.first.group;
    const sources = [...a.sources.values()].sort((x, y) => y.value - x.value);
    const token = g
      ? { id: g.id, symbol: g.displaySymbol, name: g.name, logo: g.logo ?? a.logoHint }
      : {
          id: a.first.tokenId ?? (a.first.ref ? a.first.ref : undefined),
          symbol: a.first.symbol,
          name: a.first.name ?? a.first.symbol,
          logo: a.first.logo,
        };
    holdings.push({
      key: a.key,
      token: {
        id: token.id,
        symbol: token.symbol,
        name: token.name,
        logo: token.logo,
        // 价/排名取组内「首个有值」(见 unitPriceHint 注释):组统一单位 → 单价一致,不依赖行序。
        unitPrice: a.unitPriceHint,
        marketCapRank: a.marketCapRankHint,
      },
      totalValue: a.totalValue,
      totalAmount: a.totalAmount, // 组 = 同一资产、统一单位 → 各 source 数量之和恒可汇总
      change24h: a.identities.size === 1 ? a.first.change24h : undefined,
      sources,
    });
  }
  return holdings.sort((x, y) => y.totalValue - x.totalValue);
}
