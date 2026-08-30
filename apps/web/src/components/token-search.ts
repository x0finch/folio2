import type { TokenOption } from "@/lib/core/token-model";

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

// 下拉的分组(#269;搜索排序改版)。三种类型:owned(当前账户已添加)/ catalogue(市值目录)/
// fiat(法币现金)。**浏览**时固定顺序 owned → catalogue → fiat;**搜索**时按相关性全局排序、
// 再按相邻类型切段(见 buildTokenSections)。`key` 是语义标识,组标题 i18n 由渲染层按它映射。
export type TokenSectionKey = "owned" | "fiat" | "catalogue";
export interface TokenSection {
  key: TokenSectionKey;
  items: TokenOption[];
}

// manual 账户「已有代币」组(#269)的选项:账本持仓 → 可选中的 TokenOption。
//
// **只收有票的**:能被票选回的(链上认出的 / 法币,#272)才成 option;无票的自定义 symbol 没有可
// 复用的身份、走「手动输入」路径,法币另有 Cash 组兜底。
// **不看余额** —— 已清仓(amount 0)的旧持仓也留着:账户保留已清仓持仓(与 Tokens 页一致),从这里
// 一键选回就落回同一条(mint 幂等)、历史不丢;想收窄成「现在还持有」是另一回事,当前刻意不收窄。
// name/logo 取实时富化的 `meta`(按大写 symbol,缺则回退 symbol);价留空,由下拉 SWR 按需刷。
export function buildOwnedOptions(
  holdings: readonly { ticket: string | null; symbol: string }[],
  meta: ReadonlyMap<string, { name?: string; logo?: string }>,
): TokenOption[] {
  return holdings.flatMap((h) => {
    if (!h.ticket) return [];
    const m = meta.get(h.symbol.toUpperCase());
    return [{ ticket: h.ticket, symbol: h.symbol, name: m?.name ?? h.symbol, logo: m?.logo }];
  });
}

// 搜索排序的**中性打分器**。**类型无关** —— 只看文本匹配质量,不认识 owned/fiat/catalogue、
// 也不给任何类型加成。档次(小 = 更相关):0 symbol 完全 / 1 name 完全 / 2 symbol 前缀 /
// 3 name 前缀 / 4 symbol 子串 / 5 name 子串;`null` = 不匹配。`q` 须已 trim + 小写。
// 精确匹配那一档天然压过前缀 —— 搜 `USD` 时法币 USD(symbol 完全)自然排在 USDC(前缀)之上,
// 不需要偏袒任何类型。同档再按市值 rank 兜底(小靠前、无 rank 的靠后),仍是类型无关的排序。
function matchTier(token: TokenOption, q: string): number | null {
  const sym = token.symbol.toLowerCase();
  const name = token.name.toLowerCase();
  if (sym === q) return 0;
  if (name === q) return 1;
  if (sym.startsWith(q)) return 2;
  if (name.startsWith(q)) return 3;
  if (sym.includes(q)) return 4;
  if (name.includes(q)) return 5;
  return null;
}

// 排好序的扁平列表 → 按**相邻同类型**切段,每段一个 section。**类型只在这一步用到**(纯展示,
// 不参与排序)。排序若把同类型的项隔开,该类型会出现在多个 section(如 `catalogue … owned …
// catalogue`)—— 这是「按相邻成组」的自然结果。渲染层的 section React key 须带序号(同 key 可重复)。
function segmentByKind(
  items: readonly { token: TokenOption; kind: TokenSectionKey }[],
): TokenSection[] {
  const out: TokenSection[] = [];
  for (const { token, kind } of items) {
    const last = out.at(-1);
    if (last?.key === kind) last.items.push(token);
    else out.push({ key: kind, items: [token] });
  }
  return out;
}

/**
 * 选币下拉的分组结果。
 *
 * **浏览(无输入)**:固定顺序 已有代币 → Tokens(目录前 `catalogueTopN`)→ 法币;类型本就连续,
 * 切段正好三组。
 *
 * **搜索(有输入)**:三份来源合成一个池 → 中性打分(`matchTier`,类型无关)→ 全局按相关性排序
 *(精确 > 前缀 > 子串,同档按市值 rank)→ 按相邻类型切段。于是精确命中的项(哪怕是法币)浮到最上,
 * 分组仍在、但顺序/成员随相关性走。目录先经 `searchCatalogue` 粗筛到 ~20(别把整份目录喂进全局排序)
 * 再并入上游补的 `remote`。
 *
 * **不跨来源去重**(同一个币既已添加又在目录 → 两处各出现一次,见 #267 story 16)。空来源不产段。
 */
export function buildTokenSections(input: {
  owned: readonly TokenOption[];
  fiat: readonly TokenOption[];
  catalogue: readonly TokenOption[];
  query: string;
  catalogueTopN: number;
  remote?: readonly TokenOption[];
}): TokenSection[] {
  const q = input.query.trim().toLowerCase();

  // 浏览:固定顺序,类型本就连续 → 切段即 owned / catalogue / fiat 三组(空来源不产段)。
  if (!q) {
    return segmentByKind([
      ...input.owned.map((token) => ({ token, kind: "owned" as const })),
      ...input.catalogue
        .slice(0, input.catalogueTopN)
        .map((token) => ({ token, kind: "catalogue" as const })),
      ...input.fiat.map((token) => ({ token, kind: "fiat" as const })),
    ]);
  }

  // 搜索:合池 → 中性打分 → 全局排序 → 相邻切段。目录先粗筛到 ~20 并入 remote。
  const catalogue = mergeSearchResults(searchCatalogue(input.catalogue, q), input.remote ?? []);
  const pool = [
    ...input.owned.map((token) => ({ token, kind: "owned" as const })),
    ...input.fiat.map((token) => ({ token, kind: "fiat" as const })),
    ...catalogue.map((token) => ({ token, kind: "catalogue" as const })),
  ];
  const scored: { token: TokenOption; kind: TokenSectionKey; tier: number; order: number }[] = [];
  pool.forEach((c, order) => {
    const tier = matchTier(c.token, q);
    if (tier !== null) scored.push({ token: c.token, kind: c.kind, tier, order });
  });
  // 相关性:档次升序 → 市值 rank 升序(无 rank 靠后)→ 入池序(稳定兜底,非类型加成)。
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.token.rank ?? Number.POSITIVE_INFINITY) - (b.token.rank ?? Number.POSITIVE_INFINITY) ||
      a.order - b.order,
  );
  return segmentByKind(scored);
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

// 命中高亮的纯逻辑(P7.4.5):把 text 按 query 的(大小写不敏感)匹配切成若干段,每段标 match 与否。
// 渲染层据此包裹高亮 <span> —— 本函数不含 JSX,便于单测。
export interface Segment {
  text: string;
  match: boolean;
}

// 空 query 或无匹配 → 整段一条(match:false)。匹配可多段(逐次向后查找)。
export function matchSegments(text: string, query: string): Segment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), match: false });
    out.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return out.length > 0 ? out : [{ text, match: false }];
}
