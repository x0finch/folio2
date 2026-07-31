import type {
  CacheStore,
  TokenPrice,
  TokenPriceStore,
  TokenRecord,
  TokenRecordPrice,
  TokenRef,
  TokenStore,
  TokenUpstream,
  UpstreamToken,
} from "@folio/oracle-basic";
import {
  DEFAULT_TOP_N,
  dayBucketOf,
  INFO_TTL_MS,
  MS_PER_DAY,
  normalizeSymbol,
  PRICE_TTL_MS,
} from "@folio/oracle-basic";
import { refreshCatalogue, topByRank, warmMarkets } from "./cache";
import { swr } from "./refresh";

export interface TokensDeps {
  store: TokenStore; // info facet + ref 行
  prices: TokenPriceStore; // 价 facet + 历史日价
  cache: CacheStore;
  upstream: TokenUpstream;
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
  // 选币表单预填单价:按 ref 现取,**不建行、不写缓存**。
  //
  // 为什么不能走 `priceOf`:那个收的是内部 id,而用户此刻只是在下拉里点了一下 —— 按设计
  // 这一刻还不建行(他可能就把抽屉关了,留一堆没人要的代币行)。行是提交时才由 mint 建的。
  // 取不到(上游不认识 / 网络出错)→ undefined,表单让用户自己填。
  priceByRef(ref: TokenRef): Promise<TokenPrice | undefined>;
  // 选币下拉的 SWR 刷价:一批 ref 现取(`priceByRef` 的批量版)。同样**不建行、不写缓存** ——
  // 用户还在下拉里划,行只在提交时由 mint 建。上游失败 → 空 Map,那几行显示无价(不抛)。
  pricesByRefs(refs: readonly TokenRef[]): Promise<Map<TokenRef, TokenPrice>>;
  // SWR 批量刷价:给定 token 里价 stale/缺失的,一次批量回源写回。返回刷新条数。
  refreshStalePrices(ids: readonly string[]): Promise<number>;
  // 同上,但刷的是 symbol/name/logo,而且是**覆盖**(上游权威,见 TokenStore.putInfo)。
  // 与刷价分开的理由就是 TTL:名与图近乎静态(30d),价 30min —— 合在一起会把目录端点当价格端点用。
  refreshStaleInfo(ids: readonly string[]): Promise<number>;

  // 历史日价序列(#148 / ADR 0019):命中缓存的过去日直接用,缺的一次回源补齐并永久落缓存;
  // 今日桶恒现取(可变,不缓存)。上游失败 → 退回仅缓存,不抛(曲线不因缺价崩)。
  priceSeries(
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Promise<{ atMs: number; unitPrice: number }[]>;
  // 某时刻的历史价:atMs 所属 UTC 日桶的价;该日无数据 → undefined(调用方降级)。
  priceAt(tokenId: string, atMs: number): Promise<number | undefined>;

  // 选币橱窗:市值 top-N,走 warm blob(冷则预热一次;价旧了也刷 —— 用户在看)。
  topTokens(limit: number): Promise<UpstreamToken[]>;
  // 按关键词搜币(用户选币)。恒回源 —— 结果与用户无关,边缘缓存管它。
  search(query: string): Promise<UpstreamToken[]>;

  // 后台预热:目录超过 WARM_TTL_MS(一周)就整份刷一次,否则零请求。返回目录条数。
  // **唯一主动让目录跟上的那条路** —— 写路径按设计永不刷,橱窗只在用户打开下拉时才跑。
  // 调用方须把它放在 best-effort 的位置(同步后 `waitUntil`),别挂在任何人的关键路径上。
  refreshCatalogue(): Promise<number>;
}

export function createTokens({
  store,
  prices,
  cache,
  upstream,
  now = Date.now,
}: TokensDeps): Tokens {
  // 橱窗读者:价旧了就刷(用户点开下拉、正看着这些数字)。**候选源不走这条** ——
  // 它在写路径上,判据不同,见 ./candidates(#216)。
  const rows = () => warmMarkets(cache, upstream, DEFAULT_TOP_N, now());

  const toSourceToken = (r: Awaited<ReturnType<typeof rows>>[number]): UpstreamToken => ({
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
        const raw = await upstream.fetchPriceSeries(info.ref, fromMs, toMs);
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
          const got = (await upstream.fetchPrices([info.ref])).get(info.ref);
          return got ? { ...got, stale: false } : undefined;
        },
        write: (value) => prices.put([{ tokenId, ...value }], PRICE_TTL_MS),
      });
    },

    async priceByRef(ref) {
      try {
        return (await upstream.fetchPrices([ref])).get(ref);
      } catch {
        // 上游失败(限流 / 网络)→ 表单没有预填价,用户手填。与别处同口径:不抛。
        return undefined;
      }
    },

    async pricesByRefs(refs) {
      if (refs.length === 0) return new Map();
      try {
        // upstream 已按 IDS_PER_REQUEST 分块(#245),这里整批交给它。
        return await upstream.fetchPrices(refs);
      } catch {
        // 上游失败 → 空 Map,那几行显示无价。与 priceByRef 同口径:不抛。
        return new Map();
      }
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

      const fetched = await upstream.fetchPrices([...byRef.keys()]);
      const writes = [...fetched.entries()]
        .map(([ref, price]) => {
          const tokenId = byRef.get(ref);
          return tokenId ? { tokenId, ...price } : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) await prices.put(writes, PRICE_TTL_MS);
      return writes.length;
    },

    // 刷元信息:**覆盖**已认出来的行的 symbol/name/logo。
    //
    // 为什么必须覆盖而不是填空槽:行是拿连接器报的元信息建的,而链上合约的 symbol 是部署者写在
    // 合约里的字符串 —— MATIC 改名 POL 之后链上那份还写着 MATIC。合约那条 ref 是**按地址**
    // 认出来的、认定可信,错的只是显示名。同一个币于是在链上侧显示 MATIC、在交易所侧显示 POL,
    // 而它们其实是同一行 —— 用户看到的名字取决于哪个账户先同步,这不该是随机的。
    //
    // 只刷「认得出来(ref 非空)且 info stale」的:认不出来的行没有上游名字可取,
    // 它显示连接器报的那份就是对的。
    async refreshStaleInfo(ids) {
      if (ids.length === 0) return 0;
      const infos = await store.getByIds(ids);

      const byRef = new Map<string, string>();
      for (const [id, info] of infos) {
        if (!info.infoStale || !info.ref) continue;
        byRef.set(info.ref, id);
      }
      if (byRef.size === 0) return 0;

      // 上游失败(限流 / 网络)→ 什么都不写,行保留连接器那份,下次再试。与价同口径:不抛。
      let fetched: UpstreamToken[];
      try {
        fetched = await upstream.fetchTokens([...byRef.keys()]);
      } catch {
        return 0;
      }
      const writes = fetched
        .map((t) => {
          const tokenId = byRef.get(t.ref);
          // 上游没收录的 ref 不在结果里;回来了却对不上我们要的键 → 丢掉,别乱写。
          //
          // **symbol 要归一。** 大小写是**我们**的展示口径,不是上游的 —— CoinGecko 给的是小写
          // (`usdc`),而建行那一侧是大写。不归一就出现「同一行刷一次变小写」:显示从 `USDC`
          // 跳成 `usdc`,而且 symbol 还是 symbol 消歧的比较键(见 candidatesBySymbol)。
          // 覆盖上游的**名字**是对的(MATIC→POL,见本函数上面那段),但那是内容,大小写不是。
          return tokenId
            ? { tokenId, symbol: normalizeSymbol(t.symbol), name: t.name, logo: t.logo }
            : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) await store.putInfo(writes, INFO_TTL_MS);
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

    search: (query) => upstream.searchTokens(query),

    async refreshCatalogue() {
      return (await refreshCatalogue(cache, upstream, DEFAULT_TOP_N, now())).length;
    },
  };
}
