import type { SnapshotWithBalances } from "@folio/db";
import { type TokenRecord, tokenTicket, type UpstreamToken } from "@folio/oracle-basic";
import { ZERO_DISPLAY_USD } from "@/lib/core/account-view";
import { isFungible, viewKind } from "@/lib/core/balance-kind";
import { tokenLogoUrl, toLogoSource } from "@/lib/core/logo";
import { MANUAL_CONNECTOR_ID } from "@/lib/core/manual";

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
  marketCapRank?: number; // 市值排名(展示用)
}

// 只对同质持仓取价:现货 + UTXO(BTC);defi/perp 不取(价值/展示走 typed meta)。
// kind 走 viewKind 归一(并存期兼容遗留 manual→spot、bitcoin→utxo)。
export function fungibleTokenId(b: BalanceLike): string | null {
  if (!isFungible(viewKind(b))) return null;
  return b.tokenId ?? null;
}

// defi 行的**展示用**身份(H5 #120:协议行的 name/logo 富化按它挂)。独立于 fungibleTokenId ——
// 那个门喂估值现推(liveValue),defi 行进去会被重估;这个只喂展示富化。
export function defiTokenId(b: BalanceLike): string | null {
  if (viewKind(b) !== "defi") return null;
  return b.tokenId ?? null;
}

// 永续仓位的**展示用**身份(#133):账户行的叠标要显示标的币的图标(在交易 BTC / ETH / …)。
// 与 defi 那道门同理,独立于 fungibleTokenId —— 永续仓位的价值走 typed meta,进了估值门会被重估。
//
// 权益行(`perp_equity`)有意不在内:它是抵押物,不是「持有什么」,叠标不显示它。
export function perpTokenId(b: BalanceLike): string | null {
  if (viewKind(b) !== "perp_position") return null;
  return b.tokenId ?? null;
}

// **展示富化的统一门**(同质 ∪ defi ∪ 永续仓位)。enrich / refreshStalePrices / warm 三处必须同门:
// enrich 标了 stale 而 refresh 够不到的行会让 pricesStale 永远清不掉、客户端每次加载空转一次刷新
// (code review #2)。估值现推(liveValue)不走此门,仍只认 fungibleTokenId 的同质行。
//
// **三门同源是靠这一个函数保证的,别在调用点各自加门**:`refreshableTokenIds` 也是按它筛的,
// 所以这里放进来一类,富化 / 刷价 / 预热三处同时放进来 —— 而永续的图正是靠「刷」那一半取回来的
// (连接器不报 logo,logo/正名的权威源是上游,见 token-enrich 的 `warmHeldPrices` 注释)。
export function displayTokenId(b: BalanceLike): string | null {
  return fungibleTokenId(b) ?? defiTokenId(b) ?? perpTokenId(b);
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
//   · 无 spin:标脏侧(overview 只喂 eligible,不含 defi)喂的是刷价侧(prices/refresh-stale.ts 喂全量)的**子集**。
//     `Σ|v|` 对「加行」单调不减 → 子集和 ≤ 全集和 → 标脏(子集越阈值)必蕴含刷价侧也越阈值 →
//     绝不会「标了脏却刷不到」。换成 `|Σ v|`:标脏侧只见 +500 → 标脏,刷价侧见 +500−500=0 → 跳过 →
//     客户端每次进页空转(见 token-enrich 的「三门同源」)。这正是 code-review 抓到的坑。
//
// **三类无条件保留(判不了 / 不该判):**
//   ① `usdValue` 缺失 —— 老的只带 BalanceLike 的调用点没这个字段,宁可多刷也不错杀。
//   ② manual 持仓 —— 它的 usdValue 是拿(可能是冷缓存的)现价现造的,`0` 常常只是「还没定价」
//      而非「不值钱」(选了币但没填价的手记币恒为 0);且手记是用户手挑、数量少,一律刷。
//      不豁免的话这种币会被当 dust 永不刷价 → 永远显 $0(比 issue 接受的「滞后一轮」更糟)。
//   ③ 永续仓位(#133)—— 它的 `usdValue` **恒为 0**:仓位不贡献净值(ADR 0010 / #129),
//      名义敞口住在 meta 里,而这里只看得见 `BalanceLike`。所以对它「按值判尘埃」这件事本身
//      没有意义,与①同一条理由(判不了就别错杀)。
//      **不豁免的后果是这一整类永远没有图**:实测 28 个永续币里只有 6 个有图,而那 6 个都是因为
//      用户在别的账户里也持有它们的现货 —— 图是蹭来的,不是这条路取的。
// 只在「确知聚合低于阈值」时才跳过。
export function refreshableTokenIds(
  rows: readonly BalanceLike[],
  threshold = ZERO_DISPLAY_USD,
): string[] {
  const absSum = new Map<string, number>();
  const keep = new Set<string>(); // 无条件保留(usdValue 缺失 / manual / 永续仓位)
  const order: string[] = [];
  for (const b of rows) {
    const id = displayTokenId(b);
    if (!id) continue;
    if (!absSum.has(id) && !keep.has(id)) order.push(id);
    if (
      b.usdValue == null ||
      b.platform === MANUAL_CONNECTOR_ID ||
      viewKind(b) === "perp_position"
    ) {
      keep.add(id);
    } else absSum.set(id, (absSum.get(id) ?? 0) + Math.abs(b.usdValue));
  }
  return order.filter((id) => keep.has(id) || (absSum.get(id) ?? 0) >= threshold);
}

// logo 优先源给的那张(视觉统一,warm 缓存零边际配额),缺则回退连接器自带图(备用槽);
// 上游还没认出来的币也有 name/providerLogo 可显(不再是裸 symbol + 首字母)。
export function toEnrichment(e: TokenRecord): TokenEnrichment {
  return {
    symbol: e.symbol,
    name: e.name,
    logo: tokenLogoUrl(toLogoSource(e)), // 有图→拼自家代理 /api/logo/token/{id}(不再发上游 URL),无图→undefined 显首字母;隐私 ADR 0008
    unitPrice: e.price?.unitPrice,
    marketCapRank: e.price?.marketCapRank,
  };
}

// 选币下拉里的一项 —— 选币 server fn 的**出参形状**,组件与 server fn 共用。
//
// `ticket` 是这一项的身份,一串 base64url(见 `@folio/oracle` 的 `tokenTicket`)。
// **前端原样搬运,不解释、不拆、不比较字面含义** —— 点中之后把它原样交回服务端,
// 服务端解回一条 tokenRef 再去认币。当前上游是谁、它的 id 长什么样,前端不需要知道,
// 知道了反而会在组件里长出 `split("/")` 这种东西,换源那天就地爆炸。
//
// 可以做的只有两件:当 React key 用,以及判两项是不是同一个币(串相等)。
//
// `rank` / `price` / `change24h` / `asOf` 都是**展示用的市场数据**,可缺:
//   · `rank` —— 市值排名,给下拉的消歧徽标(缺 → 不显示徽标)。默认列来自 warm markets、
//     搜索来自 /search,两者不可比但都只当「有没有 / 大概多前」用。
//   · `price` / `change24h` / `asOf` —— 现价 / 24h 涨跌 / 该价的时刻。搜索来的行没有价
//     (asOf 也无),由下拉的 SWR 刷价按需补上(见 token-search.ts 的 staleTickets)。
export interface TokenOption {
  ticket: string;
  symbol: string;
  name: string;
  logo?: string;
  rank?: number;
  price?: number;
  change24h?: number;
  asOf?: number;
}

// 用户当下「可展示余额」全集(纯逻辑,无 server import → 可单测):各账户最新快照的余额 ∪ manual 账户的
// 合成余额(manual 已退出快照,ADR 0018)。
//
// **三门同源收口**:enrich(经 injectManualSnapshots 进 byAccount)、warm(warmTokensForUser)、
// refresh(refreshStalePrices)必须喂**同一集合** —— 否则 enrich 标了 stale 的 manual 行 warm/refresh 够不到,
// pricesStale 永清不掉、客户端每次加载空转刷新(见 lib/tokens.ts 同门注)。warm 与 refresh 都经本函数,
// 保证两者结构一致,而非各自手拼(手拼正是 T2 首版漏掉 refresh 的成因)。
export function userDisplayBalances(
  snapshots: SnapshotWithBalances[],
  manualBalances: BalanceLike[],
): BalanceLike[] {
  return [...snapshots.flatMap((s) => s.balances), ...manualBalances];
}

// 上游结果 → 下拉项。**logo 是上游直链,不走 folio 代理**:代理端点按内部代币行 id 读库
// (`/api/logo/token/$id`),而这些币还没有行。ADR 0008 早就把搜索这一档记成已接受的尾巴,
// 这里只是让默认列跟它一致 —— 而默认列恰好是最无所谓的那一档:市值前 N 名人人都一样,
// 浏览器去 CoinGecko 取这几张图不泄露任何人持有什么。
// rank 两个家:markets 端点放在 `price.marketCapRank`(warm 重建的行只有这半),`/search` 无价
// 放在顶层 `marketCapRank` —— 取任一非空的那个。price/change/asOf 只有 markets 那侧带,搜索来的
// 行留空,由下拉 SWR 刷价补(见 refreshTokenPrices)。
export const toOption = (t: UpstreamToken): TokenOption => ({
  ticket: tokenTicket.encode(t.ref),
  symbol: t.symbol,
  name: t.name,
  logo: t.logo,
  rank: t.price?.marketCapRank ?? t.marketCapRank,
  price: t.price?.unitPrice,
  change24h: t.price?.change24h,
  asOf: t.price?.asOf,
});
