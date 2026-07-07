import { refKey, type TokenGroup, type TokenRef } from "@folio/tokens";

// symbol 归一(与 tokens 层同口径:trim + 大写)—— 仅用于未解析行的分组键/身份。
const norm = (s: string): string => s.trim().toUpperCase();

// 纯逻辑(无 server-only import → 可单测)。把跨账户的持仓行按【规范代币】聚合成 Holding 树。
// 设计见 docs/adr 0001–0003;术语见 CONTEXT.md。
//   · 白名单(进聚合):spot / manual / CEX 现货(kind=spot)/ perp 权益(isMargin) —— ADR-0003。
//   · 归并键四级(永不裸 symbol,ADR-0002):group → token(ref)→ tokenKey(精确合约)→ account:symbol。
//   · HoldingSource 粒度 = 账户 × 平台单元:链上按链拆(tokenKey 的 eip155/chain 前缀),其余按账户/场馆。
//   · 表头 totalAmount 仅当组内是单一 Token(所有 source 同一身份)时给,跨多 Token(桥接家族)不给。

// 聚合输入:一笔持仓 + 其解析结果(group/ref/展示,由 server 富化)。
export interface AggInput {
  symbol: string;
  amount: number;
  value: number; // USD(provider 权威;聚合按它求和)
  kind: string; // spot | defi | perp | manual
  tokenKey?: string | null;
  isMargin?: boolean; // perp 权益(保证金)—— 进聚合但明细标注
  account: { id: string; label: string; type: string; network?: string | null };
  group?: TokenGroup; // 命中种子的展示分组
  ref?: TokenRef | null; // 解析出的规范 Token(单例组身份)
  name?: string;
  logo?: string; // 已按回退链取好(CGK→provider)
  change24h?: number; // 每币 24h 涨跌(%);仅单 Token 组用于行内 ValueChange
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
  token: { id?: string; symbol: string; name: string; logo?: string };
  totalValue: number;
  totalAmount?: number; // 仅单一 Token 组
  change24h?: number; // 仅单一 Token 组(%,每币 CGK 涨跌)
  sources: HoldingSource[];
}

// 账户 type(<类别>_<具体>)→ 平台单元的 **key**(CEX/perp/manual/非 EVM 原生)。
// 只产 key;name + logo(含兜底)整个归 @folio/platforms,由 server 读路径装饰。
function platformIdFromAccount(type: string, network?: string | null): string {
  const specific = type.slice(type.indexOf("_") + 1);
  if (type.startsWith("exchange_")) return `exchange:${specific}`;
  if (type.startsWith("perp_")) return `perp:${specific}`;
  if (type.startsWith("onchain_")) return `chain:${network ?? specific}`; // solana/sui/cosmos…
  return "manual";
}

// 持有点的平台 key:链上优先按 tokenKey 的链前缀拆(同账户多链 → 多 source);否则按账户 type。
function platformIdOf(row: AggInput): string {
  const tk = row.tokenKey;
  if (tk) {
    const slash = tk.indexOf("/");
    const prefix = slash > 0 ? tk.slice(0, slash) : "";
    if (prefix.startsWith("eip155:") || prefix.startsWith("chain:")) return prefix;
    // coingecko:<id>(manual 选币)等无链前缀 → 落账户平台
  }
  return platformIdFromAccount(row.account.type, row.account.network);
}

// 单笔持仓的"代币身份"(用于判断组内是否单一 Token → 决定是否给 totalAmount)。
function tokenIdentity(row: AggInput): string {
  if (row.ref) return refKey(row.ref);
  if (row.tokenKey) return row.tokenKey;
  return `sym:${norm(row.symbol)}`;
}

// 四级归并键(ADR-0002:任何一级都不含裸 symbol)。
function holdingKey(row: AggInput): string {
  if (row.group) return `group:${row.group.id}`;
  if (row.ref) return `token:${refKey(row.ref)}`;
  if (row.tokenKey) return `tk:${row.tokenKey}`;
  return `as:${row.account.id}:${norm(row.symbol)}`;
}

function isEligible(row: AggInput): boolean {
  return row.kind === "spot" || row.kind === "manual" || row.isMargin === true;
}

interface Acc {
  key: string;
  first: AggInput;
  identities: Set<string>;
  totalValue: number;
  totalAmount: number;
  logoHint?: string; // 首个带 logo 的成员(组 logo 缺省时兜底)
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
    const g = a.first.group;
    const sources = [...a.sources.values()].sort((x, y) => y.value - x.value);
    const token = g
      ? { id: g.id, symbol: g.displaySymbol, name: g.name, logo: g.logo ?? a.logoHint }
      : {
          id: a.first.ref ? refKey(a.first.ref) : undefined,
          symbol: a.first.symbol,
          name: a.first.name ?? a.first.symbol,
          logo: a.first.logo,
        };
    holdings.push({
      key: a.key,
      token: { id: token.id, symbol: token.symbol, name: token.name, logo: token.logo },
      totalValue: a.totalValue,
      totalAmount: a.identities.size === 1 ? a.totalAmount : undefined,
      change24h: a.identities.size === 1 ? a.first.change24h : undefined,
      sources,
    });
  }
  return holdings.sort((x, y) => y.totalValue - x.totalValue);
}
