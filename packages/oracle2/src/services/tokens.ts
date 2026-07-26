import type {
  CacheStore,
  SourceToken,
  TokenPriceStore,
  TokenRecord,
  TokenRecordPrice,
  TokenSource,
  TokenStore,
} from "../contract";
import { candidatesBySymbol, topByRank, warmRows } from "./cache";
import { DEFAULT_TOP_N, dayBucketOf, MS_PER_DAY, PRICE_TTL_MS } from "./constants";
import type { CandidateSource } from "./mint";
import { swr } from "./refresh";

export interface TokensDeps {
  store: TokenStore; // info facet + ref 行
  prices: TokenPriceStore; // 价 facet + 历史日价
  cache: CacheStore;
  source: TokenSource;
  now?: () => number;
}

// 读路径。**没有「解析」这一步** —— 拿 token_id 直接取名字、图、现价、涨跌、市值排名。
// 「这是哪个币」在写路径(mint)就定死并冻进了快照,读的时候不再从 tokenRef 反推。
//
// 「上游认没认出来」不是一种状态:看 `TokenInfo.ref` 空不空(ADR 0021),行上没有孤儿标记、
// 没有复查时刻,也没有带数据源名字的字段。
//
// **现价有两个家**,这是明知接受的:持仓币的价在价 store(估值用,要能按 token 点查),
// 选币列表的价在 warm blob 里(橱窗用),两边可能差几分钟。
export interface Tokens {
  // 富化:按内部 id 批量读整行(info + 价合并)。输入**不再需要** symbol 或 tokenRef。
  enrich(ids: readonly string[]): Promise<Map<string, TokenRecord>>;
  // 按主键读一行的上游图 URL(logo 代理端点用):源给的优先,没有就用连接器自带那张。
  logoUrlById(id: string): Promise<string | undefined>;

  // 取单价:新鲜 → 直接回;stale/miss → 回源 → 写回。长尾币按需取价走这条。
  priceOf(tokenId: string): Promise<TokenRecordPrice | undefined>;
  // SWR 批量刷价:给定 token 里价 stale/缺失的,一次批量回源写回。返回刷新条数。
  refreshStalePrices(ids: readonly string[]): Promise<number>;

  // 历史日价序列(#148 / ADR 0019):命中缓存的过去日直接用,缺的一次回源补齐并永久落缓存;
  // 今日桶恒现取(可变,不缓存)。上游失败 → 退回仅缓存,不抛(曲线不因缺价崩)。
  priceSeries(
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Promise<{ atMs: number; unitPrice: number }[]>;
  // 某时刻的历史价:atMs 所属 UTC 日桶的价;该日无数据 → undefined(调用方降级)。
  priceAt(tokenId: string, atMs: number): Promise<number | undefined>;

  // 选币橱窗:市值 top-N,走 warm blob(冷则经 SWR 预热一次)。
  topTokens(limit: number): Promise<SourceToken[]>;
  // 按关键词搜币(用户选币)。恒回源 —— 结果与用户无关,边缘缓存管它。
  search(query: string): Promise<SourceToken[]>;
  // symbol 消歧候选源,喂 mint(与橱窗同一份 warm rows,不额外存)。
  candidates: CandidateSource;
}

export function createTokens({ store, prices, cache, source, now = Date.now }: TokensDeps): Tokens {
  const rows = () => warmRows(cache, source, DEFAULT_TOP_N, now());

  const toSourceToken = (r: Awaited<ReturnType<typeof rows>>[number]): SourceToken => ({
    ref: r.info.ref,
    symbol: r.info.symbol,
    name: r.info.name,
    logo: r.info.logo,
    price: r.price,
  });

  async function priceSeries(tokenId: string, fromMs: number, toMs: number) {
    const info = await store.getById(tokenId);
    // 上游还没认出它 → 取不到历史价(本源只认自己给的名字)。
    if (!info?.ref || fromMs > toMs) return [];

    const fromB = dayBucketOf(fromMs);
    const toB = dayBucketOf(toMs);
    const todayB = dayBucketOf(now());
    const buckets: number[] = [];
    for (let b = fromB; b <= toB; b++) buckets.push(b);

    const cached = await prices.getDaily(tokenId, buckets);
    const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
    const needsToday = toB >= todayB; // 今日桶恒现取(可变,不缓存)

    const fetched = new Map<number, number>();
    if (missingPast.length > 0 || needsToday) {
      try {
        const raw = await source.fetchPriceSeries(info.ref, fromMs, toMs);
        for (const pt of raw) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // 升序 → 当日最后一点胜出
      } catch {
        // 上游失败(限流 / 无历史 / 网络)→ 降级到仅缓存,不抛。
      }
      const toPersist = [...fetched.entries()]
        .filter(([b]) => b < todayB && !cached.has(b)) // 只落不可变的过去日
        .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
      if (toPersist.length > 0) await prices.putDaily(tokenId, toPersist);
    }

    const out: { atMs: number; unitPrice: number }[] = [];
    for (const b of buckets) {
      const price = cached.get(b) ?? fetched.get(b);
      if (typeof price === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: price });
    }
    return out;
  }

  return {
    priceSeries,

    candidates: {
      async bySymbol(symbol) {
        return candidatesBySymbol(await rows(), symbol);
      },
    },

    async enrich(ids) {
      if (ids.length === 0) return new Map();
      // 两个 store 各读自己那半,服务层合成整行 —— 这正是切开端口的用处。
      const [infos, priced] = await Promise.all([store.getByIds(ids), prices.getByIds(ids)]);
      const out = new Map<string, TokenRecord>();
      for (const [id, info] of infos) out.set(id, { ...info, price: priced.get(id) });
      return out;
    },

    async logoUrlById(id) {
      const info = await store.getById(id);
      return info?.logo ?? info?.providerLogo;
    },

    // 单个币的价走 SWR:新鲜直接回、stale 回源写回、上游没有则保留旧值。
    priceOf(tokenId) {
      return swr<TokenRecordPrice>({
        read: async () => {
          const hit = (await prices.getByIds([tokenId])).get(tokenId);
          return hit ? { value: hit, stale: hit.stale } : undefined;
        },
        fetch: async () => {
          const info = await store.getById(tokenId);
          if (!info?.ref) return undefined; // 认不出来的币取不了价
          const got = (await source.fetchPrices([info.ref])).get(info.ref);
          return got ? { ...got, stale: false } : undefined;
        },
        write: (value) => prices.put([{ tokenId, ...value }], PRICE_TTL_MS),
      });
    },

    async refreshStalePrices(ids) {
      if (ids.length === 0) return 0;
      const [infos, priced] = await Promise.all([store.getByIds(ids), prices.getByIds(ids)]);

      // 只刷「认得出来且价 stale/缺失」的。一次批量回源(批量场景不走 swr —— 那是单值的)。
      const byRef = new Map<string, string>();
      for (const [id, info] of infos) {
        const p = priced.get(id);
        if (p && !p.stale) continue;
        if (info.ref) byRef.set(info.ref, id);
      }
      if (byRef.size === 0) return 0;

      const fetched = await source.fetchPrices([...byRef.keys()]);
      const writes = [...fetched.entries()]
        .map(([ref, price]) => {
          const tokenId = byRef.get(ref);
          return tokenId ? { tokenId, ...price } : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) await prices.put(writes, PRICE_TTL_MS);
      return writes.length;
    },

    async priceAt(tokenId, atMs) {
      const dayStart = dayBucketOf(atMs) * MS_PER_DAY;
      const series = await priceSeries(tokenId, dayStart, atMs);
      return series.at(-1)?.unitPrice;
    },

    async topTokens(limit) {
      return topByRank(await rows(), limit).map(toSourceToken);
    },

    search: (query) => source.searchTokens(query),
  };
}
