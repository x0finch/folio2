import { tokenRef as buildRef } from "@folio/oracle-ref";
import { readWarm, refreshWarm, topTokens as topFromWarm } from "./cache";
import { CGK_NAMER, DEFAULT_TOP_N, dayBucketOf, MS_PER_DAY, PRICE_TTL_MS } from "./constants";
import type { CacheStore, SourceToken, TokenSource, TokenStore } from "./stores";
import type { PricePoint, Token, TokenPrice, TokenRef } from "./types";

export interface TokensDeps {
  store: TokenStore;
  cache: CacheStore;
  source: TokenSource;
  now?: () => number;
}

// 读路径。**没有「解析」这一步** —— 拿 token_id 直接取名字、图、现价、涨跌、市值排名。
// 「这是哪个币」在写路径(mint)就定死并冻进了快照,读的时候不再从 tokenRef 反推。
//
// 相应地,「孤儿行 / CoinGecko 行 / 复查三态」那套判别整个不存在:一个币有没有被 CoinGecko
// 认出来,看它有没有 `coingecko` 那条 ref(读出来就是 `Token.cgkCoinId`),不存额外状态。
//
// **现价有两个家**,这是明知接受的:持仓币的价在 Token 那一行(估值用,要能按 token 点查),
// 选币列表的价在 warm blob 里(橱窗用),两边可能差几分钟。
export interface Tokens {
  // 富化:按内部 id 批量读整行。输入**不再需要** symbol 或 tokenRef。miss 的 id 不出现在结果里。
  byIds(ids: readonly string[]): Promise<Map<string, Token>>;
  // 按主键读一行的上游图 URL(logo 代理端点用):CoinGecko 的优先,没有就用 provider 那张。
  logoUrlById(id: string): Promise<string | undefined>;

  // 取单价:缓存新鲜 → 直接回;stale/miss → 回源 → 写回。长尾币按需取价走这条。
  priceOf(tokenId: string): Promise<TokenPrice | undefined>;
  // SWR 批量刷价:给定 token 里价 stale/缺失的,一次批量回源写回。返回刷新条数。
  refreshStalePrices(ids: readonly string[]): Promise<number>;

  // 历史日价序列(#148 / ADR 0019):命中缓存的过去日直接用,缺的一次回源补齐并永久落缓存;
  // 今日桶恒现取(可变,不缓存)。上游失败 → 退回仅缓存,不抛(曲线不因缺价崩)。
  priceSeries(tokenId: string, fromMs: number, toMs: number): Promise<PricePoint[]>;
  // 某时刻的历史价:atMs 所属 UTC 日桶的价;该日无数据 → undefined(调用方降级)。
  priceAt(tokenId: string, atMs: number): Promise<number | undefined>;

  // 选币橱窗:市值 top-N。走 warm blob;冷缓存 → 先预热一次再读。
  topTokens(limit: number): Promise<SourceToken[]>;
  // 按关键词搜币(用户选币)。恒回源 —— 结果与用户无关,边缘缓存管它。
  search(query: string): Promise<SourceToken[]>;
}

export function createTokens({ store, cache, source, now = Date.now }: TokensDeps): Tokens {
  // 这个 Token 在上游叫什么。没有 `coingecko` 那条 ref = 还没被认出来 → 取不了价。
  const refOf = (token: Token | undefined): TokenRef | undefined =>
    token?.cgkCoinId ? buildRef.local(CGK_NAMER, token.cgkCoinId) : undefined;

  async function priceSeries(tokenId: string, fromMs: number, toMs: number): Promise<PricePoint[]> {
    const ref = refOf(await store.getById(tokenId));
    if (!ref || fromMs > toMs) return [];

    const fromB = dayBucketOf(fromMs);
    const toB = dayBucketOf(toMs);
    const todayB = dayBucketOf(now());
    const buckets: number[] = [];
    for (let b = fromB; b <= toB; b++) buckets.push(b);

    const cached = await store.getDailyPrices(tokenId, buckets);
    const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
    const needsToday = toB >= todayB;

    const fetched = new Map<number, number>();
    if (missingPast.length > 0 || needsToday) {
      try {
        const raw = await source.fetchPriceSeries(ref, fromMs, toMs);
        for (const pt of raw) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // 升序 → 当日最后一点胜出
      } catch {
        // 上游失败(限流 / 无历史 / 网络)→ 降级到仅缓存,不抛。
      }
      const toPersist = [...fetched.entries()]
        .filter(([b]) => b < todayB && !cached.has(b)) // 只落不可变的过去日
        .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
      if (toPersist.length > 0) await store.putDailyPrices(tokenId, toPersist);
    }

    const out: PricePoint[] = [];
    for (const b of buckets) {
      const price = cached.get(b) ?? fetched.get(b);
      if (typeof price === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: price });
    }
    return out;
  }

  return {
    priceSeries,

    byIds: (ids) => (ids.length === 0 ? Promise.resolve(new Map()) : store.getByIds(ids)),

    async logoUrlById(id) {
      const token = await store.getById(id);
      return token?.logo ?? token?.providerLogo;
    },

    async priceOf(tokenId) {
      const token = await store.getById(tokenId);
      // 新鲜就直接回 —— 过期不删,所以这里判的是 stale 不是「有没有」。
      if (token?.price && !token.price.stale) return token.price;

      const ref = refOf(token);
      if (!ref) return token?.price; // 认不出来的币取不了价,把旧值(若有)原样给出去
      const fetched = (await source.fetchPrices([ref])).get(ref);
      if (!fetched) return token?.price;

      await store.putPrices([{ tokenId, ...fetched }], PRICE_TTL_MS);
      return { ...fetched, stale: false };
    },

    async refreshStalePrices(ids) {
      if (ids.length === 0) return 0;
      const tokens = await store.getByIds(ids);

      // 只刷「认得出来且价 stale/缺失」的。一次批量回源。
      const byRef = new Map<TokenRef, string>();
      for (const token of tokens.values()) {
        if (token.price && !token.price.stale) continue;
        const ref = refOf(token);
        if (ref) byRef.set(ref, token.id);
      }
      if (byRef.size === 0) return 0;

      const fetched = await source.fetchPrices([...byRef.keys()]);
      const writes = [...fetched.entries()]
        .map(([ref, price]) => {
          const tokenId = byRef.get(ref);
          return tokenId ? { tokenId, ...price } : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) await store.putPrices(writes, PRICE_TTL_MS);
      return writes.length;
    },

    async priceAt(tokenId, atMs) {
      const dayStart = dayBucketOf(atMs) * MS_PER_DAY;
      const series = await priceSeries(tokenId, dayStart, atMs);
      return series.at(-1)?.unitPrice;
    },

    async topTokens(limit) {
      const top = await topFromWarm(cache, limit);
      if (top.length > 0) return top;
      try {
        await refreshWarm(cache, source, DEFAULT_TOP_N, now());
      } catch {
        // 预热失败(限流 / 网络)不阻断:返回当前(可能仍空),调用方降级。
      }
      return topFromWarm(cache, limit);
    },

    search: (query) => source.searchTokens(query),
  };
}

// warm 是否已预热过(诊断 / 冷启动判断用)。
export async function warmedAt(cache: CacheStore): Promise<number | undefined> {
  return (await readWarm(cache))?.blob.asOf;
}
