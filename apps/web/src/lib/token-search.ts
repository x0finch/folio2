import type { TokenOption } from "./token-option";

// 选币搜索的**本地那一档**:在服务端整份下发的目录(市值前 1000)里就地筛。
//
// 为什么筛在浏览器:目录本来就已经在手上了(打开记账模态框时就预取好),此时再为每个搜索词
// 走一趟服务端 + 一次 CGK 的 /search,换来的答案十有八九就在这 1000 条里。放到本地之后,
// 搜索从「防抖 250ms + 一次往返」变成「敲一个字就出结果」,而上游只在真找长尾币时才被惊动。
//
// **入参的顺序即市值排名** —— 服务端已经排好序发过来,所以这里只做稳定排序,不需要 rank 一列。

// 本地凑够这么多条就不问上游。下拉一屏也就六七行,再多是滚动的事;凑不够才说明用户在找的东西
// 不在前 1000 里。调小 = 更省上游请求、更容易漏长尾;调大 = 反过来。
export const LOCAL_SEARCH_ENOUGH = 8;
// 一次搜索最多显示多少条(本地与合并后同此上限)。
const SEARCH_RESULT_LIMIT = 20;

// 三档:symbol 全等 → symbol 或名字的前缀 → 子串。
//
// 不用纯子串,是因为敲 `BTC` 要的是比特币本身,不是名字里带 btc 的第七个包装币。
// 而 symbol 前缀与名字前缀**不再分开** —— 分开的话敲 `bitc` 第一行会是 BITCI 而不是 Bitcoin。
// 命中在哪个字段上不重要,市值才重要:同为前缀命中就交给排名,那是这份目录唯一自带的权重。
function tierOf(token: TokenOption, q: string): number {
  const symbol = token.symbol.toLowerCase();
  const name = token.name.toLowerCase();
  if (symbol === q) return 0;
  if (symbol.startsWith(q) || name.startsWith(q)) return 1;
  if (symbol.includes(q) || name.includes(q)) return 2;
  return -1;
}

/** 在目录里按关键词筛。同档之间保持入参顺序(= 市值排名)。 */
export function searchCatalogue(
  catalogue: readonly TokenOption[],
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): TokenOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: { token: TokenOption; tier: number }[] = [];
  for (const token of catalogue) {
    const tier = tierOf(token, q);
    if (tier >= 0) hits.push({ token, tier });
  }
  // Array#sort 稳定 → 同档内仍是市值序。
  hits.sort((a, b) => a.tier - b.tier);
  return hits.slice(0, limit).map((h) => h.token);
}

/** 本地这些条够不够用 —— 不够才值得为这个词问一次上游。 */
export function needsRemoteSearch(localHits: readonly TokenOption[]): boolean {
  return localHits.length < LOCAL_SEARCH_ENOUGH;
}

// 选币下拉的价过期阈值:超过它(或压根没价)就该刷。1h —— 选币这件事对价的新鲜度要求本就不高,
// 这个窗口足够让默认列的 warm 价大多数时候零请求,只有真旧了或搜索来的无价行才触发。
export const PRICE_STALE_MS = 60 * 60 * 1000;

// 一张票的现价(下拉展示 + 刷价回填共用的形状)。
export interface LivePrice {
  price: number;
  change24h?: number;
  asOf: number;
}

/**
 * 展示时挑「该刷价」的票:价缺失或超过 staleMs,且这次会话还没请求过(`requested`)。
 *
 * `requested` 是**每次打开下拉只补一次**的闸 —— 补过的票即便上游没回价(它不会进 `live`、
 * 永远算「缺价」)也不再重发,否则每次 setState 重渲染都会把它再挑出来,刷价请求打成环。
 * 生效价取 `live`(刷来的)优先、否则票自带的(默认列 warm 价);两者都无 asOf → 缺价 → 该刷。
 */
export function staleTickets(
  tokens: readonly TokenOption[],
  live: ReadonlyMap<string, LivePrice>,
  requested: ReadonlySet<string>,
  now: number,
  staleMs = PRICE_STALE_MS,
): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (requested.has(t.ticket)) continue;
    const asOf = live.get(t.ticket)?.asOf ?? t.asOf;
    if (asOf == null || now - asOf > staleMs) out.push(t.ticket);
  }
  return out;
}

/** 合并上游补的那几条:**本地在前**(它按市值排过档),按票去重,截到上限。 */
export function mergeSearchResults(
  local: readonly TokenOption[],
  remote: readonly TokenOption[],
  limit = SEARCH_RESULT_LIMIT,
): TokenOption[] {
  const seen = new Set(local.map((t) => t.ticket));
  const out = [...local];
  for (const token of remote) {
    if (out.length >= limit) break;
    if (seen.has(token.ticket)) continue;
    seen.add(token.ticket);
    out.push(token);
  }
  return out;
}
