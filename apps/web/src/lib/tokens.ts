import type { TokenRecord } from "@folio/oracle";
import { ZERO_DISPLAY_USD } from "./account-view";
import { isFungible, viewKind } from "./balance-kind";
import { tokenLogoUrl } from "./logo";
import { MANUAL_CONNECTOR_ID } from "./manual-connector";

// 纯逻辑(无 server-only import → 可单测)。把一笔余额(快照行形状)桥接到代币参考层。
//
// **读端不再解析身份**(ADR 0021 / #201):认定在写快照时由 mint 定死,余额行自己带着 `token_id`。
// 下面三个门只回答「这一行参不参与」,答案就是它的 token_id 或 null —— 以前它们要造 `AssetRef`
// (symbol + tokenRef)交给参考层现场解析,那一步整个消失了。

export interface BalanceLike {
  kind: string;
  // 写快照时 mint 定死的代币行 id。可空:本列之前写下的旧快照、以及手记那种现造的持仓(#203)。
  tokenId?: string | null;
  platform?: string | null; // 这笔持仓所在的链 ∪ 场馆(provider 直接报,#193)
  usdValue?: number | null; // provider 报的美元值;刷前按它跳过 dust(#245,见 refreshableTokenIds)
}

export interface TokenEnrichment {
  symbol?: string; // 显示名(#243 起从 Token 取,快照不再存);认不出的行取建行时连接器报的那份
  name?: string;
  logo?: string;
  unitPrice?: number; // USD
  change24h?: number; // 百分比
  marketCapRank?: number; // 市值排名(展示用)
}

// 只对同质持仓取价:现货 + UTXO(BTC);defi/perp 不取(价值/展示走 typed meta)。
// kind 走 viewKind 归一(并存期兼容遗留 manual→spot、bitcoin→utxo)。
export function fungibleTokenId(b: BalanceLike): string | null {
  if (!isFungible(viewKind(b))) return null;
  return b.tokenId ?? null;
}

// defi 行的**展示用**身份(H5 #120:协议行 24h 聚合需要 change24h)。独立于 fungibleTokenId ——
// 那个门喂估值现推(liveValue),defi 行进去会被重估;这个只喂展示富化。
export function defiTokenId(b: BalanceLike): string | null {
  if (viewKind(b) !== "defi") return null;
  return b.tokenId ?? null;
}

// **展示富化的统一门**(同质 ∪ defi)。enrich / refreshStalePrices / warm 三处必须同门:
// enrich 标了 stale 而 refresh 够不到的行会让 pricesStale 永远清不掉、客户端每次加载空转一次刷新
// (code review #2)。估值现推(liveValue)不走此门,仍只认 fungibleTokenId 的同质行。
export function displayTokenId(b: BalanceLike): string | null {
  return fungibleTokenId(b) ?? defiTokenId(b);
}

// 一批余额行 → 去重后的 token_id 列表(喂 enrich 展示 —— 要**全量**,dust 也得出名字/图)。
export function displayTokenIds(rows: readonly BalanceLike[]): string[] {
  return [
    ...new Set(rows.flatMap((b) => (displayTokenId(b) ? [displayTokenId(b) as string] : []))),
  ];
}

// **值得回源刷价/图的** token_id 集合(#245 Part 2)。数百币的钱包里绝大多数是几乎 $0 的
// 空投/貔貅币,展示层本就砍掉(见 account-view `ZERO_DISPLAY_USD`),这里在**刷之前**也砍:
// 省 CGK 配额、也是撞 414 的直接原因(id 一多 URL 就爆,见 upstream 分块)。
//
// 判据就用展示那条线 —— 「**不展示的就不刷**」:按 token 聚合 provider 报的 `usdValue`,
// ≥ ZERO_DISPLAY_USD 才留(与现货表 / 叠标同阈值、同「按 token 聚合」的粒度)。
//
// **聚合取「绝对值之和」`Σ|usdValue|`,不是「和的绝对值」`|Σ usdValue|`。** 两个理由:
//   · 语义:同一个 token 可能既有现货(+)又有 defi 借款腿(−,rabby 负债腿 amount 取负 → value 为负,
//     且 ref 与现货同源 → 同 tokenId)。对冲/循环贷仓位净值可能≈0,但两条腿都**需要**这个价,
//     绝不能因净值抵消就当它不值钱、不刷。
//   · 无 spin:标脏侧(overview 只喂 eligible,不含 defi)喂的是刷价侧(prices.ts 喂全量)的**子集**。
//     `Σ|v|` 对「加行」单调不减 → 子集和 ≤ 全集和 → 标脏(子集越阈值)必蕴含刷价侧也越阈值 →
//     绝不会「标了脏却刷不到」。换成 `|Σ v|`:标脏侧只见 +500 → 标脏,刷价侧见 +500−500=0 → 跳过 →
//     客户端每次进页空转(见 token-enrich 的「三门同源」)。这正是 code-review 抓到的坑。
//
// **两类无条件保留(判不了 / 不该判):**
//   ① `usdValue` 缺失 —— 老的只带 BalanceLike 的调用点没这个字段,宁可多刷也不错杀。
//   ② manual 持仓 —— 它的 usdValue 是拿(可能是冷缓存的)现价现造的,`0` 常常只是「还没定价」
//      而非「不值钱」(选了币但没填价的手记币恒为 0);且手记是用户手挑、数量少,一律刷。
//      不豁免的话这种币会被当 dust 永不刷价 → 永远显 $0(比 issue 接受的「滞后一轮」更糟)。
// 只在「确知聚合低于阈值」时才跳过。
export function refreshableTokenIds(
  rows: readonly BalanceLike[],
  threshold = ZERO_DISPLAY_USD,
): string[] {
  const absSum = new Map<string, number>();
  const keep = new Set<string>(); // 无条件保留(usdValue 缺失 / manual)
  const order: string[] = [];
  for (const b of rows) {
    const id = displayTokenId(b);
    if (!id) continue;
    if (!absSum.has(id) && !keep.has(id)) order.push(id);
    if (b.usdValue == null || b.platform === MANUAL_CONNECTOR_ID) keep.add(id);
    else absSum.set(id, (absSum.get(id) ?? 0) + Math.abs(b.usdValue));
  }
  return order.filter((id) => keep.has(id) || (absSum.get(id) ?? 0) >= threshold);
}

// logo 优先源给的那张(视觉统一,warm 缓存零边际配额),缺则回退连接器自带图(备用槽);
// 上游还没认出来的币也有 name/providerLogo 可显(不再是裸 symbol + 首字母)。
export function toEnrichment(e: TokenRecord): TokenEnrichment {
  return {
    symbol: e.symbol,
    name: e.name,
    logo: tokenLogoUrl(e), // 上游 URL → folio 代理(隐私;见 ADR 0008)
    unitPrice: e.price?.unitPrice,
    change24h: e.price?.change24h,
    marketCapRank: e.price?.marketCapRank,
  };
}
